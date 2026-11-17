const bcrypt = require('bcrypt');
const { db } = require('../database/init');
const activity = require('../services/activityService');
const masterService = require('../services/masterService');

exports.list = async (req, res) => {
    const currentUserRole = req.session.user.role;
    const orgId = req.session.user.organization_id || 1;
    const sql = `
        SELECT u.*, 
               d.name AS dept_name, 
               des.name AS desig_name 
        FROM users u 
        LEFT JOIN departments d ON d.id = u.department_id 
        LEFT JOIN designations des ON des.id = u.designation_id 
    `;
    let rawEmployees = [];
    if (currentUserRole === 'admin') {
        rawEmployees = await db.prepare(`${sql} WHERE u.role IN ('employee', 'manager') AND (u.organization_id=? OR u.id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY u.role DESC, u.name ASC`).all(orgId, orgId);
    } else {
        rawEmployees = await db.prepare(`${sql} WHERE u.role='employee' AND (u.organization_id=? OR u.id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY u.name ASC`).all(orgId, orgId);
    }
    const employees = rawEmployees.map(e => ({
        ...e,
        department: e.dept_name || e.department || '',
        designation: e.desig_name || e.designation || ''
    }));
    res.render('employees', { employees, currentUserRole });
};

exports.save = async (req, res) => {
    const { id, role = 'employee', name = '', email = '', phone = '', department = '', password = '' } = req.body;
    let { designation = '' } = req.body;
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    const creatorRole = req.session.user.role;
    const orgId = req.session.user.organization_id || 1;

    let targetRole = (role.toLowerCase() === 'manager' && creatorRole === 'admin') ? 'manager' : 'employee';
    if (!designation.trim()) {
        designation = targetRole === 'manager' ? 'Manager' : 'Employee';
    }

    if (!cleanName || !cleanEmail) {
        return res.status(400).render('error', { message: 'Name and email are required fields.' });
    }

    try {
        const deptObj = await masterService.findOrCreateDepartment(department);
        const desigObj = await masterService.findOrCreateDesignation(designation);

        const deptId = deptObj ? deptObj.id : null;
        const desigId = desigObj ? desigObj.id : null;
        const deptName = deptObj ? deptObj.name : department;
        const desigName = desigObj ? desigObj.name : designation;

        // Check unique name across all users
        const nameDuplicate = id
            ? await db.prepare("SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(?) AND id <> ?").get(cleanName.toLowerCase(), id)
            : await db.prepare("SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(?)").get(cleanName.toLowerCase());

        if (nameDuplicate) {
            const msg = `A user with the name "${cleanName}" already exists. Name must be unique.`;
            if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.json({ success: false, message: msg });
            }
            return res.render('error', { message: msg });
        }

        // Check unique email across all users
        const emailDuplicate = id
            ? await db.prepare("SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(?) AND id <> ?").get(cleanEmail, id)
            : await db.prepare("SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(?)").get(cleanEmail);

        if (emailDuplicate) {
            const msg = `A user with the email "${cleanEmail}" already exists. Email must be unique.`;
            if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.json({ success: false, message: msg });
            }
            return res.render('error', { message: msg });
        }

        if (id) {
            const existing = await db.prepare("SELECT * FROM users WHERE id=?").get(id);
            if (!existing) {
                if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                    return res.json({ success: false, message: 'User not found' });
                }
                return res.render('error', { message: 'User not found' });
            }
            if (creatorRole !== 'admin' && existing.role !== 'employee') {
                if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                    return res.json({ success: false, message: 'Access denied.' });
                }
                return res.render('error', { message: 'Access denied.' });
            }

            if (password) {
                await db.prepare("UPDATE users SET role=?,name=?,email=?,phone=?,department=?,designation=?,department_id=?,designation_id=?,password=? WHERE id=?")
                    .run(targetRole, cleanName, cleanEmail, phone, deptName, desigName, deptId, desigId, await bcrypt.hash(password, 12), id);
            } else {
                await db.prepare("UPDATE users SET role=?,name=?,email=?,phone=?,department=?,designation=?,department_id=?,designation_id=? WHERE id=?")
                    .run(targetRole, cleanName, cleanEmail, phone, deptName, desigName, deptId, desigId, id);
            }
            await activity.log(req.session.user.id, `${targetRole === 'manager' ? 'Manager' : 'Employee'} Updated`, cleanName);
        } else {
            // Check organization plan user limit
            const orgLimitRow = await db.prepare("SELECT COALESCE(max_users, 10) AS max_users, COALESCE(plan, 'free') AS plan FROM organizations WHERE id=?").get(orgId);
            const maxUsers = orgLimitRow ? orgLimitRow.max_users : 10;
            const currentUsersRow = await db.prepare(`
                SELECT COUNT(DISTINCT u.id) AS count 
                FROM users u 
                WHERE u.organization_id = ? 
                   OR u.id IN (SELECT user_id FROM user_organizations WHERE organization_id = ?)
            `).get(orgId, orgId);
            const currentUsers = currentUsersRow ? currentUsersRow.count : 0;

            const isJsonReq = !!(req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('json')) || (req.get && req.get('accept') && req.get('accept').includes('json')) || (req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest'));

            if (currentUsers >= maxUsers) {
                const limitMsg = `User limit reached for your plan (${currentUsers}/${maxUsers} members). Upgrade to Paid (25 users) or Enterprise plan to add more members.`;
                if (isJsonReq) {
                    return res.status(403).json({ success: false, message: limitMsg, error: limitMsg });
                }
                return res.status(403).render('error', { message: limitMsg });
            }

            if (!password) {
                if (isJsonReq) {
                    return res.status(400).json({ success: false, message: 'Password is required for new team member.' });
                }
                return res.status(400).render('error', { message: 'Password is required for new team member.' });
            }
            const result = await db.prepare("INSERT INTO users(role,name,email,password,phone,department,designation,department_id,designation_id,created_by,organization_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
                .run(targetRole, cleanName, cleanEmail, await bcrypt.hash(password, 12), phone, deptName, desigName, deptId, desigId, req.session.user.id, orgId);
            const newUserId = result.lastInsertRowid;
            try {
                await db.prepare("INSERT IGNORE INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, ?)").run(newUserId, orgId, targetRole);
            } catch (e) {}
            await activity.log(req.session.user.id, `${targetRole === 'manager' ? 'Manager' : 'Employee'} Created`, cleanName);
        }
        
        const isJsonReq = !!(req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('json')) || (req.get && req.get('accept') && req.get('accept').includes('json')) || (req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest'));
        if (isJsonReq) {
            return res.json({ success: true });
        }
        res.redirect('/employees');
    } catch (e) {
        console.error('Error saving team member:', e);
        const msg = 'Could not save team member. Please make sure name and email are unique.';
        const isJsonReq = !!(req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('json')) || (req.get && req.get('accept') && req.get('accept').includes('json')) || (req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest'));
        if (isJsonReq) {
            return res.status(500).json({ success: false, message: msg, error: msg });
        }
        res.status(500).render('error', { message: msg });
    }
};

exports.toggle = async (req, res) => {
    try {
        const user = await db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
        let nextState = user ? (user.active ? 0 : 1) : 0;
        if (user && (req.session.user.role === 'admin' || user.role === 'employee')) {
            await db.prepare('UPDATE users SET active=? WHERE id=?').run(nextState, user.id);
            await activity.log(req.session.user.id, `User ${nextState ? 'Activated' : 'Deactivated'}`, user.name);
        }

        if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.json({ success: true, id: user ? user.id : req.params.id, active: Boolean(nextState) });
        }
        res.redirect('/employees');
    } catch (e) {
        if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.status(500).json({ success: false, message: e.message });
        }
        res.redirect('/employees');
    }
};

exports.remove = async (req, res) => {
    try {
        const user = await db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
        if (!user) {
            if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.status(404).json({ success: false, message: 'User not found' });
            }
            return res.status(404).render('error', { message: 'User not found' });
        }

        if (req.session.user.role !== 'admin' && user.role !== 'employee') {
            if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }
            return res.status(403).render('error', { message: 'Access denied.' });
        }

        const adminUser = await db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
        const fallbackAdminId = adminUser ? adminUser.id : req.session.user.id;

        // 1. Clean up project_assignees, project_updates, user_organizations
        try { await db.prepare('DELETE FROM user_organizations WHERE user_id=?').run(user.id); } catch(e){}
        try { await db.prepare('DELETE FROM project_assignees WHERE user_id=?').run(user.id); } catch(e){}
        try { await db.prepare('DELETE FROM project_updates WHERE manager_id=?').run(user.id); } catch(e){}

        // 2. Handle projects where user is manager_id or created_by
        const projects = await db.prepare('SELECT id, manager_id FROM projects WHERE created_by=? OR FIND_IN_SET(?, manager_id) > 0').all(user.id, user.id);
        for (const p of projects) {
            const currentManagers = String(p.manager_id || '').split(',').map(x => Number(x.trim())).filter(x => x && x !== user.id);
            const newManagerStr = currentManagers.length > 0 ? currentManagers.join(',') : String(fallbackAdminId);
            await db.prepare('UPDATE projects SET manager_id=?, created_by=CASE WHEN created_by=? THEN ? ELSE created_by END WHERE id=?').run(
                newManagerStr, user.id, fallbackAdminId, p.id
            );
        }

        // 3. Clean up tasks, task_assignees, task_forward_logs, daily_routines, daily_routine_logs
        try { await db.prepare('DELETE FROM task_assignees WHERE user_id=?').run(user.id); } catch(e){}
        try { await db.prepare('DELETE FROM task_forward_logs WHERE from_user_id=? OR to_user_id=?').run(user.id, user.id); } catch(e){}
        try { await db.prepare('DELETE FROM daily_routine_logs WHERE assigned_to=?').run(user.id); } catch(e){}
        try { await db.prepare('DELETE FROM daily_routines WHERE assigned_to=? OR created_by=?').run(user.id, user.id); } catch(e){}
        
        // Update tasks created by this user or assigned to this user
        try { await db.prepare('UPDATE tasks SET created_by=? WHERE created_by=?').run(fallbackAdminId, user.id); } catch(e){}
        try { await db.prepare('DELETE FROM tasks WHERE assigned_to=? OR FIND_IN_SET(?, assigned_to) > 0').run(String(user.id), String(user.id)); } catch(e){}

        // 4. Clean up notifications, comments, attachments, audit logs
        try { await db.prepare('DELETE FROM notifications WHERE user_id=?').run(user.id); } catch(e){}
        try { await db.prepare('DELETE FROM comments WHERE user_id=?').run(user.id); } catch(e){}
        try { await db.prepare('DELETE FROM attachments WHERE user_id=?').run(user.id); } catch(e){}
        try { await db.prepare('DELETE FROM audit_events WHERE user_id=?').run(user.id); } catch(e){}
        try { await db.prepare('UPDATE activity_logs SET user_id=NULL WHERE user_id=?').run(user.id); } catch(e){}

        // 5. Finally delete the user safely
        await db.prepare('DELETE FROM users WHERE id=?').run(user.id);
        await activity.log(req.session.user.id, 'User Deleted', user.name);

        if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.json({ success: true, id: user.id, message: 'User deleted successfully' });
        }
        res.redirect('/employees');
    } catch (e) {
        console.error('Error removing user:', e);
        if (req.xhr || req.headers.accept?.includes('json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            return res.status(500).json({ success: false, message: e.message });
        }
        res.status(500).render('error', { message: 'Could not delete user: ' + e.message });
    }
};

// Legacy Backwards-Compatibility Handlers (Redirecting to unified /employees)
exports.managerList = (req, res) => res.redirect('/employees');
exports.managerSave = exports.save;
exports.managerToggle = exports.toggle;
exports.managerRemove = exports.remove;
