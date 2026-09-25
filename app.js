const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const database = require('./database/init');
const {
    exposeUser
} = require('./middleware/auth');
const helpers = require('./utils/helpers');
const notifications = require('./services/notificationService');

process.on('uncaughtException', (err) => {
    console.error('CRITICAL UNCAUGHT EXCEPTION (Server kept running):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL UNHANDLED REJECTION (Server kept running):', reason);
});

async function start() {
    await database.init();
    fs.mkdirSync(config.uploadDir, {
        recursive: true
    });
    const webApp = express();
    if (config.cookieSecure) webApp.set('trust proxy', 1);
    webApp.set('view engine', 'ejs');
    webApp.set('views', path.join(config.root, 'views'));
    webApp.use(helmet({
        contentSecurityPolicy: false
    }));
    webApp.use(express.urlencoded({
        extended: false,
        limit: '10mb'
    }));
    webApp.use(express.json({
        limit: '10mb'
    }));
    webApp.use(express.text({
        limit: '10mb'
    }));
    webApp.use(express.static(path.join(config.root, 'public'), {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('manifest.json')) {
                res.setHeader('Content-Type', 'application/manifest+json');
            }
            if (filePath.endsWith('sw.js')) {
                res.setHeader('Service-Worker-Allowed', '/');
                res.setHeader('Cache-Control', 'no-cache');
            }
        }
    }));
    const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (1 month) in milliseconds
    const sessionOptions = {
        ...config.mysql,
        clearExpired: true,
        checkExpirationInterval: 900000, // Clean expired sessions every 15 mins
        expiration: ONE_MONTH_MS, // Keep sessions valid in DB for 30 days
        schema: {
            tableName: (config.tablePrefix || 'uno_') + 'sessions',
            columnNames: {
                session_id: 'session_id',
                expires: 'expires',
                data: 'data'
            }
        }
    };
    webApp.use(session({
        store: new MySQLStore(sessionOptions),
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        rolling: true, // Renews cookie expiration on every user request
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: config.cookieSecure,
            maxAge: ONE_MONTH_MS // 30 days (1 month)
        }
    }));
    webApp.use(exposeUser);
    webApp.use(require('./middleware/audit'));
    webApp.use(async (req, res, next) => {
        try {
            Object.assign(res.locals, helpers);
            if (req.session.user) {
                notifications.syncOverdue().catch(e => console.error('Background syncOverdue error:', e));
                const unreadRow = await database.db.prepare('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND is_read=0').get(req.session.user.id);
                res.locals.unread = unreadRow ? unreadRow.count : 0;
            } else {
                res.locals.unread = 0;
            }
            next();
        } catch (e) {
            next(e);
        }
    });
    webApp.use(require('./routes/audit'));
    webApp.use('/api/chat', require('./routes/aiRoutes'));
    
    // Prevent aggressive caching of EJS/HTML pages in WebViews/browsers
    webApp.use((req, res, next) => {
        if (req.method === 'GET' && (!req.xhr && req.headers.accept?.includes('text/html'))) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        }
        next();
    });

    // Safe res.render wrapper to catch EJS render & template syntax errors gracefully
    webApp.use((req, res, next) => {
        const _render = res.render.bind(res);
        res.render = function(view, options, callback) {
            try {
                _render(view, options, (err, html) => {
                    if (err) {
                        console.error(`EJS Render Error in view '${view}':`, err);
                        if (typeof callback === 'function') return callback(err, html);
                        return next(err);
                    }
                    if (typeof callback === 'function') return callback(null, html);
                    res.send(html);
                });
            } catch (e) {
                console.error(`Sync EJS Exception in '${view}':`, e);
                next(e);
            }
        };
        next();
    });

    webApp.use(require('./routes'));
    webApp.use((req, res) => res.status(404).render('error', {
        message: 'Page not found'
    }));
    webApp.use((err, req, res, next) => {
        console.error('Unhandled Application Error:', err);
        const isEjsError = err && (String(err.message || '').includes('<%') || String(err.message || '').includes('EJS') || err.name === 'SyntaxError');
        const cleanMessage = isEjsError 
            ? 'A temporary template processing issue occurred. Please try refreshing or returning to the previous page.'
            : (err.message || 'Something went wrong');

        try {
            res.status(500).render('error', {
                message: cleanMessage
            });
        } catch (renderErr) {
            console.error('Error rendering error page fallback:', renderErr);
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head><title>System Notice</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f8fafc;color:#1e293b}h1{color:#ef4444}a{color:#3b68b7;font-weight:bold;text-decoration:none}</style></head>
                <body>
                    <h1>Something went wrong</h1>
                    <p>A temporary system error occurred. Please try refreshing.</p>
                    <a href="/dashboard">Go back to Dashboard</a>
                </body>
                </html>
            `);
        }
    });

    const server = await new Promise((resolve, reject) => {
        const instance = webApp.listen(config.port);
        instance.once('listening', () => resolve(instance));
        instance.once('error', reject);
    });
    console.log(`TVA running at http://localhost:${config.port}`);
    return {
        webApp,
        server
    };
}
if (require.main === module) start().catch(error => {
    console.error('Startup failed:', error);
    process.exitCode = 1;
});
module.exports = {
    start
};