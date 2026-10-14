const { db } = require('../database/init');

function requireAuth(req,res,next){ if(!req.session.user) return res.redirect('/login'); next(); }
function requireAdmin(req,res,next){ if(req.session.user?.role !== 'admin') return res.status(403).render('error',{message:'Access denied'}); next(); }
function requireManager(req,res,next){ if(!['admin','manager'].includes(req.session.user?.role)) return res.status(403).render('error',{message:'Access denied'}); next(); }
function requireOnlyManager(req,res,next){ if(req.session.user?.role!=='manager') return res.status(403).render('error',{message:'Only a manager can perform this action'}); next(); }

async function exposeUser(req, res, next) {
    if (req.session.user) {
        try {
            if (!req.session.impersonatingOrg) {
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
            currentOrg = await db.prepare("SELECT id, name FROM organizations WHERE id=?").get(orgId);
        } catch (err) {
            console.error('Error fetching org in exposeUser:', err.message);
        }

        res.locals.currentOrg = currentOrg || { id: orgId, name: 'Unomok' };
        res.locals.isSuperAdmin = !!(req.session.user && (req.session.user.id === 1 || req.session.user.email === 'admin@gmail.com' || req.session.is_superadmin));
        res.locals.impersonatingOrg = req.session.impersonatingOrg || null;
    } else {
        res.locals.currentOrgId = 1;
        res.locals.userOrgs = [];
        res.locals.currentOrg = { id: 1, name: 'Unomok' };
        res.locals.isSuperAdmin = false;
        res.locals.impersonatingOrg = null;
    }
    res.locals.user = req.session.user || null;
    next();
}

module.exports={requireAuth,requireAdmin,requireManager,requireOnlyManager,exposeUser};
