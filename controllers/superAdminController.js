const bcrypt = require('bcrypt');
const { db, getPool, sqlName } = require('../database/init');

/**
 * Middleware: Verify Super Admin access
 * Super admin is either user.id === 1, email === 'admin@gmail.com', or session.is_superadmin === true
 */
function requireSuperAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.redirect('/superadmin/login');
    }
    const u = req.session.user;
    const isSuperAdmin = (u.id === 1 || u.email === 'admin@gmail.com' || u.organization_id === 1 && u.role === 'admin' || req.session.is_superadmin);
    if (!isSuperAdmin) {
        return res.status(403).render('error', { message: 'Access Denied: Super Admin privileges required.' });
    }
    next();
}

/**
 * GET /superadmin/login
 */
function loginPage(req, res) {
    if (req.session && req.session.user && (req.session.user.id === 1 || req.session.user.email === 'admin@gmail.com' || req.session.is_superadmin)) {
        return res.redirect('/superadmin');
    }
    res.render('superadmin/login', { error: null });
}

/**
 * POST /superadmin/login
 */
async function login(req, res) {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');

        if (!email || !password) {
            return res.render('superadmin/login', { error: 'Please enter both email and password.' });
        }

        const user = await db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
        if (!user) {
            return res.render('superadmin/login', { error: 'Invalid super admin credentials.' });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.render('superadmin/login', { error: 'Invalid super admin credentials.' });
        }

        // Must be an admin user
        if (user.role !== 'admin') {
            return res.render('superadmin/login', { error: 'Access denied: User is not an Administrator.' });
        }

        req.session.regenerate((err) => {
            if (err) return res.render('superadmin/login', { error: 'Session error. Please try again.' });
            req.session.user = {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                organization_id: user.organization_id || 1
            };
            req.session.is_superadmin = true;
            req.session.save(() => {
                res.redirect('/superadmin');
            });
        });
    } catch (err) {
        console.error('Super Admin Login Error:', err);
        res.render('superadmin/login', { error: 'Internal server error during login.' });
    }
}

/**
 * POST /superadmin/logout
 */
function logout(req, res) {
    if (req.session) {
        req.session.destroy(() => {
            res.redirect('/superadmin/login');
        });
    } else {
        res.redirect('/superadmin/login');
    }
}

/**
 * GET /superadmin
 * Main Single Page Super Admin Dashboard
 */
async function dashboard(req, res) {
    try {
        // Ensure active column exists on organizations table
        try {
            const pool = getPool();
            await pool.query(sqlName("ALTER TABLE organizations ADD COLUMN active BOOLEAN DEFAULT TRUE"));
        } catch (e) {
            // Already exists or handled
        }

        // 1. Overall Platform Stats
        const totalOrgsRow = await db.prepare("SELECT COUNT(*) count FROM organizations").get();
        const totalUsersRow = await db.prepare("SELECT COUNT(*) count FROM users").get();
        const totalProjectsRow = await db.prepare("SELECT COUNT(*) count FROM projects WHERE name != 'Self Task'").get();
        const totalTasksRow = await db.prepare("SELECT COUNT(*) count FROM tasks").get();
        const completedTasksRow = await db.prepare("SELECT COUNT(*) count FROM tasks WHERE status IN ('Completed', '2')").get();
        const overdueTasksRow = await db.prepare("SELECT COUNT(*) count FROM tasks WHERE due_date < CURDATE() AND status NOT IN ('Completed', 'Cancelled', '2', '3')").get();

        const stats = {
            totalOrgs: totalOrgsRow ? totalOrgsRow.count : 0,
            totalUsers: totalUsersRow ? totalUsersRow.count : 0,
            totalProjects: totalProjectsRow ? totalProjectsRow.count : 0,
            totalTasks: totalTasksRow ? totalTasksRow.count : 0,
            completedTasks: completedTasksRow ? completedTasksRow.count : 0,
            overdueTasks: overdueTasksRow ? overdueTasksRow.count : 0
        };

        // 2. All Organizations with dynamic metrics & Primary Admin info
        const orgs = await db.prepare(`
            SELECT 
                o.id,
                o.name,
                COALESCE(o.active, 1) AS active,
                o.created_at,
                (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id OR u.id IN (SELECT user_id FROM user_organizations WHERE organization_id = o.id)) AS user_count,
                (SELECT COUNT(*) FROM projects p WHERE p.organization_id = o.id AND p.name != 'Self Task') AS project_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.organization_id = o.id) AS task_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.organization_id = o.id AND t.status IN ('Completed', '2')) AS completed_task_count
            FROM organizations o
            ORDER BY o.id ASC
        `).all();

        // 3. Attach primary admin details for each organization
        for (const org of orgs) {
            const admin = await db.prepare(`
                SELECT id, name, email, phone 
                FROM users 
                WHERE role = 'admin' AND (organization_id = ? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id = ?))
                ORDER BY id ASC
                LIMIT 1
            `).get(org.id, org.id);

            org.admin = admin || { name: 'Not Assigned', email: '-', phone: '-' };
        }

        res.render('superadmin/dashboard', {
            title: 'Platform Super Admin',
            user: req.session.user,
            stats,
            orgs
        });
    } catch (err) {
        console.error('Super Admin Dashboard Error:', err);
        res.status(500).render('error', { message: 'Failed to load Super Admin dashboard: ' + err.message });
    }
}

/**
 * POST /superadmin/api/organizations
 * Create New Organization & Admin in 1 Click
 */
async function createOrganization(req, res) {
    try {
        const { orgName, adminName, adminEmail, adminPassword, adminPhone } = req.body;

        if (!orgName || !orgName.trim()) {
            return res.status(400).json({ success: false, message: 'Organization name is required.' });
        }
        if (!adminEmail || !adminEmail.trim()) {
            return res.status(400).json({ success: false, message: 'Admin email is required.' });
        }
        if (!adminPassword || adminPassword.length < 4) {
            return res.status(400).json({ success: false, message: 'Admin password must be at least 4 characters.' });
        }

        const cleanEmail = adminEmail.trim().toLowerCase();

        // Check if email already exists
        const existingUser = await db.prepare('SELECT id, email FROM users WHERE LOWER(TRIM(email)) = ?').get(cleanEmail);
        if (existingUser) {
            return res.status(400).json({ success: false, message: `A user with email "${cleanEmail}" already exists. Please use a unique email.` });
        }

        const pool = getPool();

        // 1. Insert into organizations
        const orgResult = await db.prepare('INSERT INTO organizations (name, active) VALUES (?, 1)').run(orgName.trim());
        const orgId = orgResult.lastInsertRowid;

        // 2. Initialize task counter for new org
        await pool.query(sqlName('INSERT INTO organization_task_counters (organization_id, last_task_number) VALUES (?, 0) ON DUPLICATE KEY UPDATE organization_id=organization_id'), [orgId]);

        // 3. Hash password and insert Admin user
        const passwordHash = await bcrypt.hash(adminPassword.trim(), 12);
        const userResult = await db.prepare(`
            INSERT INTO users (role, name, email, password, phone, department, designation, organization_id, created_by, active)
            VALUES ('admin', ?, ?, ?, ?, 'Management', 'Administrator', ?, 1, 1)
        `).run(adminName.trim() || 'Admin', cleanEmail, passwordHash, (adminPhone || '').trim(), orgId);
        const adminId = userResult.lastInsertRowid;

        // 4. Link admin to user_organizations
        await pool.query(sqlName('INSERT IGNORE INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, "admin")'), [adminId, orgId]);

        // 5. Create default "Self Task" system project for this organization
        await db.prepare(`
            INSERT INTO projects (name, description, start_date, end_date, status, status_id, created_by, manager_id, organization_id)
            VALUES ('Self Task', 'System project for self-assigned tasks', CURDATE(), '2099-12-31', 1, 1, ?, ?, ?)
        `).run(adminId, String(adminId), orgId);

        return res.json({
            success: true,
            message: `Organization "${orgName.trim()}" created successfully!`,
            organization: {
                id: orgId,
                name: orgName.trim(),
                admin: {
                    id: adminId,
                    name: adminName.trim() || 'Admin',
                    email: cleanEmail,
                    phone: (adminPhone || '').trim()
                },
                user_count: 1,
                project_count: 0,
                task_count: 0,
                active: 1,
                created_at: new Date().toISOString()
            }
        });
    } catch (err) {
        console.error('Create Organization Error:', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
}

/**
 * POST /superadmin/api/organizations/:id/update
 * Edit Organization Name / Active status
 */
async function updateOrganization(req, res) {
    try {
        const orgId = Number(req.params.id);
        const { name, active } = req.body;

        if (!orgId) return res.status(400).json({ success: false, message: 'Invalid organization ID.' });
        if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Organization name cannot be empty.' });

        const activeVal = (active === false || active === 0 || active === '0') ? 0 : 1;

        await db.prepare('UPDATE organizations SET name=?, active=? WHERE id=?').run(name.trim(), activeVal, orgId);

        return res.json({ success: true, message: 'Organization updated successfully.' });
    } catch (err) {
        console.error('Update Organization Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

/**
 * GET /superadmin/api/organizations/:id/users
 * Fetch all users belonging to an organization
 */
async function getOrgUsers(req, res) {
    try {
        const orgId = Number(req.params.id);
        if (!orgId) return res.status(400).json({ success: false, message: 'Invalid organization ID.' });

        const org = await db.prepare('SELECT id, name FROM organizations WHERE id=?').get(orgId);
        if (!org) return res.status(404).json({ success: false, message: 'Organization not found.' });

        const users = await db.prepare(`
            SELECT 
                u.id, 
                u.name, 
                u.email, 
                u.role, 
                u.phone, 
                u.department, 
                u.designation, 
                u.active, 
                u.created_at
            FROM users u
            WHERE u.organization_id = ? OR u.id IN (SELECT user_id FROM user_organizations WHERE organization_id = ?)
            ORDER BY 
                CASE u.role 
                    WHEN 'admin' THEN 1 
                    WHEN 'manager' THEN 2 
                    ELSE 3 
                END, 
                u.name ASC
        `).all(orgId, orgId);

        return res.json({ success: true, organization: org, users });
    } catch (err) {
        console.error('Get Org Users Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

/**
 * POST /superadmin/api/organizations/:id/users
 * Add a User to an Organization
 */
async function addOrgUser(req, res) {
    try {
        const orgId = Number(req.params.id);
        const { name, email, password, role, department, designation, phone } = req.body;

        if (!orgId) return res.status(400).json({ success: false, message: 'Invalid organization ID.' });
        if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name is required.' });
        if (!email || !email.trim()) return res.status(400).json({ success: false, message: 'Email is required.' });
        if (!password || password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });

        const cleanEmail = email.trim().toLowerCase();
        const existing = await db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = ?').get(cleanEmail);
        if (existing) {
            return res.status(400).json({ success: false, message: `Email "${cleanEmail}" is already registered.` });
        }

        const validRole = ['admin', 'manager', 'employee'].includes(role) ? role : 'employee';
        const passwordHash = await bcrypt.hash(password.trim(), 12);

        const result = await db.prepare(`
            INSERT INTO users (role, name, email, password, phone, department, designation, organization_id, created_by, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
        `).run(
            validRole,
            name.trim(),
            cleanEmail,
            passwordHash,
            (phone || '').trim(),
            (department || '').trim(),
            (designation || '').trim(),
            orgId
        );

        const userId = result.lastInsertRowid;
        const pool = getPool();
        await pool.query(sqlName('INSERT IGNORE INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, ?)'), [userId, orgId, validRole]);

        return res.json({
            success: true,
            message: `User "${name.trim()}" added to organization successfully!`,
            user: {
                id: userId,
                name: name.trim(),
                email: cleanEmail,
                role: validRole,
                department: (department || '').trim(),
                designation: (designation || '').trim(),
                active: 1
            }
        });
    } catch (err) {
        console.error('Add Org User Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

/**
 * POST /superadmin/api/users/:id/reset-password
 * Reset user password from Super Admin
 */
async function resetUserPassword(req, res) {
    try {
        const userId = Number(req.params.id);
        const { newPassword } = req.body;

        if (!userId) return res.status(400).json({ success: false, message: 'Invalid user ID.' });
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });
        }

        const passwordHash = await bcrypt.hash(newPassword.trim(), 12);
        await db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash, userId);

        return res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) {
        console.error('Reset Password Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

/**
 * POST /superadmin/api/users/:id/toggle
 * Toggle user active/inactive
 */
async function toggleUserActive(req, res) {
    try {
        const userId = Number(req.params.id);
        if (!userId) return res.status(400).json({ success: false, message: 'Invalid user ID.' });

        const user = await db.prepare('SELECT id, active FROM users WHERE id=?').get(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        const newActive = user.active ? 0 : 1;
        await db.prepare('UPDATE users SET active=? WHERE id=?').run(newActive, userId);

        return res.json({ success: true, active: newActive, message: `User ${newActive ? 'activated' : 'deactivated'}.` });
    } catch (err) {
        console.error('Toggle User Active Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

/**
 * GET /superadmin/switch-org/:id
 * 1-Click Impersonate / Switch to any Organization as Admin
 */
async function switchOrg(req, res) {
    try {
        const targetOrgId = Number(req.params.id);
        if (!targetOrgId) return res.redirect('/superadmin');

        const org = await db.prepare('SELECT id, name FROM organizations WHERE id=?').get(targetOrgId);
        if (!org) return res.redirect('/superadmin');

        // Find primary admin of this org or fall back to system admin
        let targetUser = await db.prepare(`
            SELECT * FROM users 
            WHERE role='admin' AND active=1 AND (organization_id=? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id=?))
            LIMIT 1
        `).get(targetOrgId, targetOrgId);

        if (!targetUser) {
            targetUser = req.session.user;
        }

        // Set session user to this organization
        req.session.user = {
            id: targetUser.id,
            name: targetUser.name,
            email: targetUser.email,
            role: 'admin',
            organization_id: targetOrgId
        };
        req.session.is_superadmin = true;
        req.session.impersonatingOrg = {
            id: org.id,
            name: org.name
        };

        req.session.save(() => {
            res.redirect('/projects');
        });
    } catch (err) {
        console.error('Super Admin Switch Org Error:', err);
        res.redirect('/superadmin');
    }
}

module.exports = {
    requireSuperAdmin,
    loginPage,
    login,
    logout,
    dashboard,
    createOrganization,
    updateOrganization,
    getOrgUsers,
    addOrgUser,
    resetUserPassword,
    toggleUserActive,
    switchOrg
};
