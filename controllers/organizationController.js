const { db } = require('../database/init');

/**
 * POST /api/organization/switch
 * Body: { organization_id }
 * Switches the active organization in the user's session without logging out.
 */
exports.switchOrganization = async (req, res) => {
    try {
        const user = req.session.user;
        if (!user) return res.status(401).json({ success: false, message: 'Not authenticated' });

        const targetOrgId = Number(req.body.organization_id);
        if (!targetOrgId) return res.status(400).json({ success: false, message: 'Invalid organization_id' });

        const isSuperAdmin = !!(user && (user.id === 1 || user.email === 'admin@gmail.com' || user.email === 'bhavin@gmail.com' || req.session.is_superadmin));

        let membership = null;
        if (isSuperAdmin) {
            // Super Admin can switch into any active organization
            const org = await db.prepare('SELECT id AS organization_id, name FROM organizations WHERE id=? AND active=1').get(targetOrgId);
            if (!org) return res.status(404).json({ success: false, message: 'Organization not found or inactive.' });
            membership = { organization_id: org.organization_id, name: org.name, role: 'admin' };
        } else {
            // Regular user: verify membership via user_organizations or default organization_id
            membership = await db.prepare(`
                SELECT o.id AS organization_id, o.name, COALESCE(uo.role, u.role, 'member') AS role
                FROM organizations o
                LEFT JOIN user_organizations uo ON uo.organization_id = o.id AND uo.user_id = ?
                LEFT JOIN users u ON u.id = ? AND u.organization_id = o.id
                WHERE o.id = ? AND o.active = 1 AND (uo.user_id = ? OR u.id = ?)
            `).get(user.id, user.id, targetOrgId, user.id, user.id);
        }

        if (!membership) {
            return res.status(403).json({ success: false, message: 'You do not have access to that organization.' });
        }

        // Update active organization in session
        req.session.user.organization_id = targetOrgId;

        // If a specific role is defined for this organization, adopt that role in session
        if (membership.role) {
            req.session.user.role = membership.role;
        }

        req.session.save(err => {
            if (err) return res.status(500).json({ success: false, message: 'Session save error' });
            res.json({
                success: true,
                message: `Switched to ${membership.name}`,
                organization: membership
            });
        });
    } catch (err) {
        console.error('Switch org error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};
