const { db } = require('../database/init');

function requireAuth(req,res,next){ if(!req.session.user) return res.redirect('/login'); next(); }
function requireAdmin(req,res,next){ if(req.session.user?.role !== 'admin') return res.status(403).render('error',{message:'Access denied'}); next(); }
function requireManager(req,res,next){ if(!['admin','manager'].includes(req.session.user?.role)) return res.status(403).render('error',{message:'Access denied'}); next(); }
function requireOnlyManager(req,res,next){ if(req.session.user?.role!=='manager') return res.status(403).render('error',{message:'Only a manager can perform this action'}); next(); }

async function exposeUser(req, res, next) {
    if (req.session.user) {
        try {
            // Only set default organization_id if user has none set in session
            if (!req.session.user.organization_id) {
                const dbUser = await db.prepare("SELECT organization_id FROM users WHERE id=?").get(req.session.user.id);
                if (dbUser && dbUser.organization_id) {
                    req.session.user.organization_id = dbUser.organization_id;
                }
            }
        } catch (err) {
            console.error('Error fetching user org in exposeUser:', err.message);
        }

        const orgId = req.session.user.organization_id || 1;
        res.locals.currentOrgId = orgId;
        
        let currentOrg = null;
        try {
            currentOrg = await db.prepare("SELECT id, name, COALESCE(plan, 'free') AS plan, COALESCE(max_users, 10) AS max_users, COALESCE(ai_enabled, 0) AS ai_enabled, COALESCE(reports_enabled, 0) AS reports_enabled, plan_expires_at FROM organizations WHERE id=?").get(orgId);
        } catch (err) {
            console.error('Error fetching org in exposeUser:', err.message);
        }

        res.locals.currentOrg = currentOrg || { id: orgId, name: 'Unomok', plan: 'free', max_users: 10, ai_enabled: 0, reports_enabled: 0 };
        res.locals.aiEnabled = !!(res.locals.currentOrg && res.locals.currentOrg.ai_enabled);
        res.locals.reportsEnabled = !!(res.locals.currentOrg && res.locals.currentOrg.reports_enabled);
        res.locals.orgPlan = res.locals.currentOrg.plan || 'free';
        res.locals.maxUsers = res.locals.currentOrg.max_users || 10;
        res.locals.isSuperAdmin = !!(req.session.user && (req.session.user.id === 1 || req.session.user.email === 'admin@gmail.com' || req.session.user.email === 'bhavin@gmail.com' || req.session.is_superadmin));
        res.locals.impersonatingOrg = req.session.impersonatingOrg || null;

        // Fetch all organizations accessible by this user for the workspace switcher
        let userOrgs = [];
        try {
            if (res.locals.isSuperAdmin) {
                // Super Admin can switch across all active organizations
                userOrgs = await db.prepare("SELECT id, name, 'admin' AS role FROM organizations WHERE active=1 ORDER BY id=1 DESC, name ASC").all();
            } else {
                userOrgs = await db.prepare(`
                    SELECT DISTINCT o.id, o.name, COALESCE(uo.role, u.role, 'member') AS role
                    FROM organizations o
                    LEFT JOIN user_organizations uo ON uo.organization_id = o.id AND uo.user_id = ?
                    LEFT JOIN users u ON u.id = ? AND u.organization_id = o.id
                    WHERE (uo.user_id = ? OR u.id = ?) AND o.active = 1
                    ORDER BY o.name ASC
                `).all(req.session.user.id, req.session.user.id, req.session.user.id, req.session.user.id);
            }
        } catch (err) {
            console.error('Error fetching userOrgs in exposeUser:', err.message);
        }
        res.locals.userOrgs = userOrgs || [];

        // Ensure active account has a switch token and expose for client-side multi-account sync
        if (!req.session.user.switch_token) {
            try {
                const dbUser = await db.prepare("SELECT password FROM users WHERE id=?").get(req.session.user.id);
                const pwdSnippet = (dbUser && dbUser.password) ? String(dbUser.password).slice(0, 20) : '';
                const crypto = require('crypto');
                const secret = process.env.SESSION_SECRET || 'tva_secret_token_key_2026';
                req.session.user.switch_token = crypto.createHmac('sha256', secret)
                    .update(`${req.session.user.id}:${req.session.user.email}:${orgId}:${pwdSnippet}`)
                    .digest('hex');
            } catch(e) {}
        }

        res.locals.currentAccount = {
            id: req.session.user.id,
            name: req.session.user.name,
            email: req.session.user.email,
            role: req.session.user.role,
            organization_id: orgId,
            organization_name: (res.locals.currentOrg && res.locals.currentOrg.name) ? res.locals.currentOrg.name : 'Workspace',
            photo: req.session.user.photo || '',
            token: req.session.user.switch_token || ''
        };
    } else {
        res.locals.currentAccount = null;
        res.locals.currentOrgId = 1;
        res.locals.userOrgs = [];
        res.locals.currentOrg = { id: 1, name: 'Unomok', plan: 'enterprise', max_users: 100, ai_enabled: 1, reports_enabled: 1 };
        res.locals.aiEnabled = true;
        res.locals.reportsEnabled = true;
        res.locals.orgPlan = 'enterprise';
        res.locals.maxUsers = 100;
        res.locals.isSuperAdmin = false;
        res.locals.impersonatingOrg = null;
    }
    res.locals.user = req.session.user || null;
    next();
}

module.exports={requireAuth,requireAdmin,requireManager,requireOnlyManager,exposeUser};
