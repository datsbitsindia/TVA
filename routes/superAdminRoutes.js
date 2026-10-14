const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/superAdminController');

// Authentication routes
router.get('/login', ctrl.loginPage);
router.post('/login', ctrl.login);
router.post('/logout', ctrl.logout);
router.get('/logout', ctrl.logout);

// Main Single Page Super Admin Dashboard
router.get('/', ctrl.requireSuperAdmin, ctrl.dashboard);

// Organization APIs
router.post('/api/organizations', ctrl.requireSuperAdmin, ctrl.createOrganization);
router.post('/api/organizations/:id/update', ctrl.requireSuperAdmin, ctrl.updateOrganization);
router.get('/api/organizations/:id/users', ctrl.requireSuperAdmin, ctrl.getOrgUsers);
router.post('/api/organizations/:id/users', ctrl.requireSuperAdmin, ctrl.addOrgUser);

// User Management APIs
router.post('/api/users/:id/reset-password', ctrl.requireSuperAdmin, ctrl.resetUserPassword);
router.post('/api/users/:id/toggle', ctrl.requireSuperAdmin, ctrl.toggleUserActive);

// 1-Click Switch / Impersonate Organization
router.get('/switch-org/:id', ctrl.requireSuperAdmin, ctrl.switchOrg);

module.exports = router;
