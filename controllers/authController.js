const bcrypt = require('bcrypt');
const { db, getPool, sqlName } = require('../database/init');
const activity = require('../services/activityService');

exports.loginPage = (req, res) => res.render('login', { error: null });

exports.login = async (req, res, next) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const user = await db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
        if (!user || !await bcrypt.compare(req.body.password || '', user.password)) {
            return res.render('login', { error: 'Invalid email or password' });
        }

        // Fetch this user's organization
        const orgId = user.organization_id || 1;
        const userOrg = await db.prepare('SELECT id, name FROM organizations WHERE id=?').get(orgId);
        const organizations = userOrg ? [userOrg] : [{ id: 1, name: 'Unomok' }];

        req.session.regenerate(err => {
            if (err) return next(err);
            req.session.user = {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                organization_id: orgId,
                organizations
            };
            req.session.save(async saveError => {
                if (saveError) return next(saveError);
                try { await activity.log(user.id, 'Login'); } catch (logError) {
                    console.error('Login activity could not be recorded:', logError.message);
                }
                res.redirect(user.role === 'admin' ? '/projects' : user.role === 'employee' ? '/tasks' : '/dashboard');
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
    activity.log(id, 'Logout');
    req.session.destroy(() => res.redirect('/login'));
};
