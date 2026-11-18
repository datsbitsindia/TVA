const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db, getPool, sqlName } = require('../database/init');
const activity = require('../services/activityService');

function generateSwitchToken(user) {
    const secret = process.env.SESSION_SECRET || 'tva_secret_token_key_2026';
    const pwdSnippet = (user && user.password) ? String(user.password).slice(0, 20) : '';
    return crypto.createHmac('sha256', secret)
        .update(`${user.id}:${user.email}:${user.organization_id}:${pwdSnippet}`)
        .digest('hex');
}

exports.generateSwitchToken = generateSwitchToken;

exports.loginPage = (req, res) => res.render('login', { error: null });

exports.login = async (req, res, next) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const plainPassword = String(req.body.password || '');
        const requestedOrgId = req.body.organization_id ? Number(req.body.organization_id) : null;
        const isJson = !!(req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('json')) || (req.get && req.get('accept') && req.get('accept').includes('json')) || (req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest'));

        if (!email || !plainPassword) {
            const msg = 'Email and password are required.';
            return isJson ? res.status(400).json({ success: false, message: msg }) : res.render('login', { error: msg });
        }

        // Find all active accounts matching this email across organizations
        const candidates = await db.prepare(`
            SELECT u.*, o.name AS org_name, o.active AS org_active 
            FROM users u 
            LEFT JOIN organizations o ON o.id = u.organization_id 
            WHERE LOWER(TRIM(u.email)) = LOWER(?) AND u.active = 1
        `).all(email);

        if (!candidates || candidates.length === 0) {
            const msg = 'Invalid email or password';
            return isJson ? res.status(401).json({ success: false, message: msg }) : res.render('login', { error: msg });
        }

        // Match against correct candidate using bcrypt
        let matchedUser = null;
        for (const cand of candidates) {
            if (requestedOrgId && cand.organization_id !== requestedOrgId) continue;
            if (await bcrypt.compare(plainPassword, cand.password)) {
                matchedUser = cand;
                break;
            }
        }

        // Fallback: if requestedOrgId didn't match, test all candidates
        if (!matchedUser && requestedOrgId) {
            for (const cand of candidates) {
                if (await bcrypt.compare(plainPassword, cand.password)) {
                    matchedUser = cand;
                    break;
                }
            }
        }

        if (!matchedUser) {
            const msg = 'Invalid email or password';
            return isJson ? res.status(401).json({ success: false, message: msg }) : res.render('login', { error: msg });
        }

        // Fetch this user's organization details
        const orgId = matchedUser.organization_id || 1;
        const orgName = matchedUser.org_name || 'Workspace';
        const switchToken = generateSwitchToken(matchedUser);

        req.session.regenerate(err => {
            if (err) return next(err);
            req.session.user = {
                id: matchedUser.id,
                name: matchedUser.name,
                email: matchedUser.email,
                role: matchedUser.role,
                organization_id: orgId,
                org_name: orgName,
                organizations: [{ id: orgId, name: orgName }],
                switch_token: switchToken
            };
            req.session.save(async saveError => {
                if (saveError) return next(saveError);
                try { await activity.log(matchedUser.id, 'Login'); } catch (logError) {
                    console.error('Login activity could not be recorded:', logError.message);
                }
                const redirectUrl = matchedUser.role === 'admin' ? '/projects' : matchedUser.role === 'employee' ? '/tasks' : '/dashboard';
                if (isJson) {
                    return res.json({
                        success: true,
                        message: `Logged in as ${matchedUser.name}`,
                        account: {
                            id: matchedUser.id,
                            name: matchedUser.name,
                            email: matchedUser.email,
                            role: matchedUser.role,
                            organization_id: orgId,
                            organization_name: orgName,
                            photo: matchedUser.photo || '',
                            token: switchToken
                        },
                        redirectUrl
                    });
                }
                res.redirect(redirectUrl);
            });
        });
    } catch (error) {
        next(error);
    }
};

exports.registerPage = (req, res) => res.render('register', { error: null, orgName: '', name: '', email: '', phone: '' });

exports.register = async (req, res, next) => {
    try {
        const orgName = (req.body.orgName || '').trim();
        const name = (req.body.name || '').trim();
        const email = (req.body.email || '').trim().toLowerCase();
        const password = (req.body.password || '').trim();
        const phone = (req.body.phone || '').trim();

        if (!orgName) {
            return res.render('register', { error: 'Company or Organization name is required.', orgName, name, email, phone });
        }
        if (!name) {
            return res.render('register', { error: 'Your full name is required.', orgName, name, email, phone });
        }
        if (!email) {
            return res.render('register', { error: 'Valid email address is required.', orgName, name, email, phone });
        }
        if (!password || password.length < 4) {
            return res.render('register', { error: 'Password must be at least 4 characters.', orgName, name, email, phone });
        }

        const existing = await db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = ?').get(email);
        if (existing) {
            return res.render('register', { error: 'An account with this email already exists. Please log in.', orgName, name, email, phone });
        }

        const pool = getPool();

        // 1. Create Free Organization (Max 10 users, no AI, no reports)
        const orgRes = await db.prepare("INSERT INTO organizations (name, active, plan, max_users, ai_enabled, reports_enabled) VALUES (?, 1, 'free', 10, 0, 0)").run(orgName);
        const orgId = orgRes.lastInsertRowid;

        // 2. Initialize task counter for new org
        if (pool) {
            await pool.query(sqlName('INSERT INTO organization_task_counters (organization_id, last_task_number) VALUES (?, 0) ON DUPLICATE KEY UPDATE organization_id=organization_id'), [orgId]);
        }

        // 3. Create Admin user
        const passwordHash = await bcrypt.hash(password, 12);
        const userRes = await db.prepare(`
            INSERT INTO users (role, name, email, password, phone, department, designation, organization_id, created_by, active)
            VALUES ('admin', ?, ?, ?, ?, 'Management', 'Administrator', ?, 1, 1)
        `).run(name, email, passwordHash, phone, orgId);
        const adminId = userRes.lastInsertRowid;

        // 4. Link admin to user_organizations
        if (pool) {
            await pool.query(sqlName('INSERT IGNORE INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, "admin")'), [adminId, orgId]);
        }

        // 5. Create default "Self Task" system project for this organization
        await db.prepare(`
            INSERT INTO projects (name, description, start_date, end_date, status, status_id, created_by, manager_id, organization_id)
            VALUES ('Self Task', 'System project for self-assigned tasks', CURDATE(), '2099-12-31', 1, 1, ?, ?, ?)
        `).run(adminId, String(adminId), orgId);

        // Auto-login newly registered admin safely
        const finalizeLogin = () => {
            req.session.user = {
                id: adminId,
                name,
                email,
                role: 'admin',
                organization_id: orgId,
                organizations: [{ id: orgId, name }]
            };
            const onSave = async () => {
                try { await activity.log(adminId, 'Registered Organization', orgName); } catch (e) {}
                res.redirect('/projects');
            };
            if (typeof req.session.save === 'function') {
                req.session.save(onSave);
            } else {
                onSave();
            }
        };

        if (typeof req.session.regenerate === 'function') {
            req.session.regenerate(err => {
                if (err) return res.redirect('/login');
                finalizeLogin();
            });
        } else {
            finalizeLogin();
        }
    } catch (err) {
        console.error('Registration error:', err);
        res.render('register', { error: 'Failed to create organization: ' + err.message, orgName: req.body.orgName || '', name: req.body.name || '', email: req.body.email || '', phone: req.body.phone || '' });
    }
};

exports.apiRegister = async (req, res) => {
    try {
        const orgName = (req.body.orgName || '').trim();
        const name = (req.body.name || req.body.adminName || '').trim();
        const email = (req.body.email || req.body.adminEmail || '').trim().toLowerCase();
        const password = (req.body.password || req.body.adminPassword || '').trim();
        const phone = (req.body.phone || req.body.adminPhone || '').trim();

        if (!orgName) return res.status(400).json({ success: false, message: 'Organization name is required.' });
        if (!name) return res.status(400).json({ success: false, message: 'Name is required.' });
        if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
        if (!password || password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });

        const existing = await db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = ?').get(email);
        if (existing) return res.status(400).json({ success: false, message: `An account with email "${email}" already exists. Please log in.` });

        const pool = getPool();

        // 1. Create Free Organization
        const orgRes = await db.prepare("INSERT INTO organizations (name, active, plan, max_users, ai_enabled, reports_enabled) VALUES (?, 1, 'free', 10, 0, 0)").run(orgName);
        const orgId = orgRes.lastInsertRowid;

        // 2. Task counter
        if (pool) {
            await pool.query(sqlName('INSERT INTO organization_task_counters (organization_id, last_task_number) VALUES (?, 0) ON DUPLICATE KEY UPDATE organization_id=organization_id'), [orgId]);
        }

        // 3. Admin user
        const passwordHash = await bcrypt.hash(password, 12);
        const userRes = await db.prepare(`
            INSERT INTO users (role, name, email, password, phone, department, designation, organization_id, created_by, active)
            VALUES ('admin', ?, ?, ?, ?, 'Management', 'Administrator', ?, 1, 1)
        `).run(name, email, passwordHash, phone, orgId);
        const adminId = userRes.lastInsertRowid;

        // 4. Link admin
        if (pool) {
            await pool.query(sqlName('INSERT IGNORE INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, "admin")'), [adminId, orgId]);
        }

        // 5. Default Self Task project
        await db.prepare(`
            INSERT INTO projects (name, description, start_date, end_date, status, status_id, created_by, manager_id, organization_id)
            VALUES ('Self Task', 'System project for self-assigned tasks', CURDATE(), '2099-12-31', 1, 1, ?, ?, ?)
        `).run(adminId, String(adminId), orgId);

        // Auto-login session if requested via browser
        if (req.session) {
            req.session.user = {
                id: adminId,
                name,
                email,
                role: 'admin',
                organization_id: orgId,
                organizations: [{ id: orgId, name }]
            };
        }

        return res.json({
            success: true,
            message: `Organization "${orgName}" created successfully on Free Plan!`,
            redirect: '/projects'
        });
    } catch (err) {
        console.error('API Register Error:', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
};

exports.logout = (req, res) => {
    const id = req.session.user?.id;
    if (id) activity.log(id, 'Logout');
    req.session.destroy(() => res.redirect('/login'));
};

/**
 * POST /api/account/add
 * Body: { email, password, organization_id (optional) }
 * Authenticates another account and logs the session into that account,
 * returning the new account profile + switch token so client stores it.
 */
exports.addAccount = async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const plainPassword = String(req.body.password || '');
        const requestedOrgId = req.body.organization_id ? Number(req.body.organization_id) : null;

        if (!email || !plainPassword) {
            return res.status(400).json({ success: false, message: 'Email and password are required.' });
        }

        const candidates = await db.prepare(`
            SELECT u.*, o.name AS org_name, o.active AS org_active 
            FROM users u 
            LEFT JOIN organizations o ON o.id = u.organization_id 
            WHERE LOWER(TRIM(u.email)) = LOWER(?) AND u.active = 1
        `).all(email);

        if (!candidates || candidates.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        let matchedUser = null;
        for (const cand of candidates) {
            if (requestedOrgId && cand.organization_id !== requestedOrgId) continue;
            if (await bcrypt.compare(plainPassword, cand.password)) {
                matchedUser = cand;
                break;
            }
        }

        if (!matchedUser && requestedOrgId) {
            for (const cand of candidates) {
                if (await bcrypt.compare(plainPassword, cand.password)) {
                    matchedUser = cand;
                    break;
                }
            }
        }

        if (!matchedUser) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        const orgId = matchedUser.organization_id || 1;
        const orgName = matchedUser.org_name || 'Workspace';
        const switchToken = generateSwitchToken(matchedUser);

        req.session.user = {
            id: matchedUser.id,
            name: matchedUser.name,
            email: matchedUser.email,
            role: matchedUser.role,
            organization_id: orgId,
            org_name: orgName,
            organizations: [{ id: orgId, name: orgName }],
            switch_token: switchToken
        };

        req.session.save(async saveError => {
            if (saveError) return res.status(500).json({ success: false, message: 'Session save failed' });
            try { await activity.log(matchedUser.id, 'Added & Switched Profile', matchedUser.name); } catch(e) {}
            return res.json({
                success: true,
                message: `Account "${matchedUser.name}" added successfully!`,
                account: {
                    id: matchedUser.id,
                    name: matchedUser.name,
                    email: matchedUser.email,
                    role: matchedUser.role,
                    organization_id: orgId,
                    organization_name: orgName,
                    photo: matchedUser.photo || '',
                    token: switchToken
                },
                redirectUrl: matchedUser.role === 'admin' ? '/projects' : matchedUser.role === 'employee' ? '/tasks' : '/dashboard'
            });
        });
    } catch (err) {
        console.error('Add Account Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/account/switch-profile
 * Body: { userId, token }
 * Instant 1-click switch between remembered profiles without re-entering password.
 */
exports.switchProfile = async (req, res) => {
    try {
        const { userId, token } = req.body;
        if (!userId || !token) {
            return res.status(400).json({ success: false, message: 'User ID and security token are required.' });
        }

        const user = await db.prepare(`
            SELECT u.*, o.name AS org_name, o.active AS org_active 
            FROM users u 
            LEFT JOIN organizations o ON o.id = u.organization_id 
            WHERE u.id = ? AND u.active = 1
        `).get(Number(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'Profile account not found or has been deactivated.' });
        }

        const expectedToken = generateSwitchToken(user);
        if (token !== expectedToken) {
            return res.status(401).json({ success: false, message: 'Security token mismatch. Please re-login to this account.' });
        }

        const orgId = user.organization_id || 1;
        const orgName = user.org_name || 'Workspace';

        req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            organization_id: orgId,
            org_name: orgName,
            organizations: [{ id: orgId, name: orgName }],
            switch_token: expectedToken
        };

        req.session.save(async saveError => {
            if (saveError) return res.status(500).json({ success: false, message: 'Session save failed' });
            try { await activity.log(user.id, 'Switched Profile', user.name); } catch(e) {}
            return res.json({
                success: true,
                message: `Switched to ${user.name} (${orgName})`,
                redirectUrl: user.role === 'admin' ? '/projects' : user.role === 'employee' ? '/tasks' : '/dashboard'
            });
        });
    } catch (err) {
        console.error('Switch Profile Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * GET /api/account/current
 * Returns the active account info + fresh switch token for client sync.
 */
exports.currentAccount = (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }
    const u = req.session.user;
    return res.json({
        success: true,
        account: {
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            organization_id: u.organization_id,
            organization_name: u.org_name || (res.locals.currentOrg && res.locals.currentOrg.name) || 'Workspace',
            photo: u.photo || '',
            token: u.switch_token || ''
        }
    });
};
