const ExcelJS = require('exceljs');
const { db } = require('../database/init');

exports.exportExcel = async (req, res, next) => {
    try {
        const u = req.session.user;
        const orgId = u.organization_id || 1;
        const selectedProject = req.query.project_id ? Number(req.query.project_id) : null;

        // Get Organization Name
        const orgRow = await db.prepare('SELECT name FROM organizations WHERE id=?').get(orgId);
        const orgName = orgRow?.name || 'TVA';

        // 1. Fetch Task List
        let taskWhere = `WHERE t.organization_id=?`;
        let taskArgs = [orgId];
        if (selectedProject) {
            taskWhere = `WHERE t.organization_id=? AND t.project_id=?`;
            taskArgs = [orgId, selectedProject];
        }

        const taskStatusSql = `COALESCE(
            (SELECT name FROM statuses WHERE id = ta_sub.status_id LIMIT 1),
            (SELECT name FROM statuses WHERE normalized_name = LOWER(CAST(ta_sub.status AS CHAR)) COLLATE utf8mb4_unicode_ci LIMIT 1),
            (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
            CAST(t.status AS CHAR) COLLATE utf8mb4_unicode_ci, 'Pending'
        )`;

        const tasksSql = `
            SELECT t.id, t.task_number, t.title, t.description, t.due_date, t.created_at, t.completed_at,
                   t.priority, t.created_by, t.assigned_to, t.is_verified,
                   COALESCE(
                       (SELECT name FROM priorities WHERE id = t.priority_id LIMIT 1),
                       t.priority, 'Medium'
                   ) AS priority_name,
                   ${taskStatusSql} AS status_name,
                   COALESCE(
                       (SELECT GROUP_CONCAT(u.name ORDER BY u.name SEPARATOR ', ') FROM task_assignees ta2 JOIN users u ON u.id=ta2.user_id WHERE ta2.task_id=t.id),
                       (SELECT GROUP_CONCAT(u.name ORDER BY u.id SEPARATOR ', ') FROM users u WHERE FIND_IN_SET(u.id, t.assigned_to) > 0),
                       a.name
                   ) AS assigned_name,
                   c.name AS creator_name,
                   p.name AS project_name,
                   v.name AS verifier_name,
                   CASE WHEN t.due_date < CURDATE() AND ${taskStatusSql} NOT IN ('Completed', 'Cancelled', '2', '3') THEN 1 ELSE 0 END AS is_overdue
            FROM tasks t
            LEFT JOIN task_assignees ta_sub ON ta_sub.task_id = t.id AND ta_sub.user_id = ?
            LEFT JOIN users a ON a.id = t.assigned_to
            LEFT JOIN users c ON c.id = t.created_by
            LEFT JOIN projects p ON p.id = t.project_id
            LEFT JOIN users v ON v.id = t.verified_by
            ${taskWhere}
            ORDER BY t.created_at DESC
        `;
        const tasks = await db.prepare(tasksSql).all(u.id, ...taskArgs);

        // 2. Fetch Employee Workload
        const empTaskWhere = selectedProject ? 'AND t.project_id=?' : '';
        const empTaskArgs = selectedProject ? [orgId, selectedProject] : [orgId];
        const empSql = `
            SELECT u.name AS label, u.designation,
                   COUNT(DISTINCT t.id) AS total_assigned,
                   COUNT(DISTINCT CASE WHEN (t.status IN ('Completed','2') OR t.status_id=2) THEN t.id END) AS completed,
                   COUNT(DISTINCT CASE WHEN (t.status IN ('In Progress','1') OR t.status_id=1) THEN t.id END) AS in_progress,
                   COUNT(DISTINCT CASE WHEN (t.status IN ('Pending','Planned','0','4') OR t.status_id IN (0,4) OR COALESCE(t.status_id,0)=0) THEN t.id END) AS pending,
                   COUNT(DISTINCT CASE WHEN (t.due_date < CURDATE() AND t.status NOT IN ('Completed','Cancelled','2','3') AND COALESCE(t.status_id,0) NOT IN (2,3)) THEN t.id END) AS overdue
            FROM users u
            LEFT JOIN tasks t ON ((FIND_IN_SET(u.id, REPLACE(t.assigned_to, ' ', '')) > 0 OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id=u.id)) AND t.organization_id=? ${empTaskWhere})
            WHERE u.active=1 AND (u.role IN ('employee','manager','admin')) AND (u.organization_id=? OR u.id IN (SELECT user_id FROM user_organizations WHERE organization_id=?))
            GROUP BY u.id, u.name, u.designation
            ORDER BY total_assigned DESC, label ASC
        `;
        const employees = await db.prepare(empSql).all(...empTaskArgs, orgId, orgId);

        // 3. Fetch Project Performance
        const projSql = `
            SELECT p.name AS label,
                   (SELECT u.name FROM users u WHERE u.id = CAST(SUBSTRING_INDEX(p.manager_id, ',', 1) AS UNSIGNED)) AS manager_name,
                   COUNT(t.id) AS total_tasks,
                   SUM(CASE WHEN t.status IN ('Completed','2') OR t.status_id=2 THEN 1 ELSE 0 END) AS completed_tasks
            FROM projects p
            LEFT JOIN tasks t ON t.project_id=p.id
            WHERE p.organization_id=? ${selectedProject ? 'AND p.id=?' : ''}
            GROUP BY p.id, p.name, p.manager_id
            ORDER BY total_tasks DESC, p.name ASC
        `;
        const projArgs = selectedProject ? [orgId, selectedProject] : [orgId];
        const projects = await db.prepare(projSql).all(...projArgs);

        // Create Excel Workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'TVA Task Manager';
        workbook.created = new Date();

        // Helper: Apply Header Style (Colored Fill, White Text, Bold, Borders)
        const applyHeaderStyle = (row, fillColorHex = '1E40AF') => {
            row.height = 26;
            row.eachCell((cell) => {
                cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColorHex } };
                cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'CBD5E1' } },
                    left: { style: 'thin', color: { argb: 'CBD5E1' } },
                    bottom: { style: 'medium', color: { argb: '0F172A' } },
                    right: { style: 'thin', color: { argb: 'CBD5E1' } }
                };
            });
        };

        // Helper: Apply Data Cell Style
        const applyDataStyle = (row, isEven = false) => {
            row.height = 22;
            row.eachCell((cell) => {
                cell.font = { name: 'Arial', size: 10, color: { argb: '1E293B' } };
                cell.alignment = { vertical: 'middle' };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'E2E8F0' } },
                    left: { style: 'thin', color: { argb: 'E2E8F0' } },
                    bottom: { style: 'thin', color: { argb: 'E2E8F0' } },
                    right: { style: 'thin', color: { argb: 'E2E8F0' } }
                };
                if (isEven) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8FAFC' } };
                }
            });
        };

        // ─── SHEET 1: Summary Overview ───────────────────────────────────────
        const wsSummary = workbook.addWorksheet('Overview Summary');
        wsSummary.views = [{ showGridLines: true }];

        // Title Block Banner
        wsSummary.mergeCells('A1:C1');
        const titleCell = wsSummary.getCell('A1');
        titleCell.value = `${orgName.toUpperCase()} — TASK PERFORMANCE REPORT`;
        titleCell.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FFFFFF' } };
        titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E3A8A' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
        wsSummary.getRow(1).height = 32;

        wsSummary.addRow([]);

        // Meta Info
        wsSummary.addRow(['Report Date:', new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })]);
        wsSummary.addRow(['Generated By:', `${u.name} (${u.role})`]);
        wsSummary.addRow(['Project Scope:', selectedProject && projects.length ? projects[0].label : 'All Projects']);
        
        wsSummary.getRow(3).font = { bold: true };
        wsSummary.getRow(4).font = { bold: true };
        wsSummary.getRow(5).font = { bold: true };

        wsSummary.addRow([]);

        // Calculate KPI Metrics
        const totalTasks = tasks.length;
        const completedTasks = tasks.filter(t => ['completed', '2'].includes(String(t.status_name).toLowerCase())).length;
        const inProgressTasks = tasks.filter(t => ['in progress', '1'].includes(String(t.status_name).toLowerCase())).length;
        const pendingTasks = tasks.filter(t => ['pending', 'planned', '0', '4'].includes(String(t.status_name).toLowerCase())).length;
        const overdueTasks = tasks.filter(t => t.is_overdue).length;
        const completionRate = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;

        // KPI Table Headers
        const kpiHeaderRow = wsSummary.addRow(['Metric', 'Count / Value', 'Percentage / Details']);
        applyHeaderStyle(kpiHeaderRow, '2563EB');

        const kpiRows = [
            ['Total Tasks', totalTasks, '100%'],
            ['Completed Tasks', completedTasks, `${completionRate}%`],
            ['In Progress Tasks', inProgressTasks, totalTasks ? `${Math.round((inProgressTasks / totalTasks) * 100)}%` : '0%'],
            ['Pending Tasks', pendingTasks, totalTasks ? `${Math.round((pendingTasks / totalTasks) * 100)}%` : '0%'],
            ['Overdue Tasks', overdueTasks, overdueTasks > 0 ? 'Requires Immediate Action' : 'All On Schedule'],
            ['Overall Completion Rate', `${completionRate}%`, completionRate >= 75 ? 'Healthy' : (completionRate >= 40 ? 'Moderate' : 'Low')]
        ];

        kpiRows.forEach((r, idx) => {
            const row = wsSummary.addRow(r);
            applyDataStyle(row, idx % 2 === 1);
            row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
        });

        wsSummary.getColumn(1).width = 28;
        wsSummary.getColumn(2).width = 20;
        wsSummary.getColumn(3).width = 32;


        // ─── SHEET 2: Detailed Tasks List ─────────────────────────────────────
        const wsTasks = workbook.addWorksheet('Tasks Details');
        wsTasks.views = [{ showGridLines: true }];

        const taskHeaders = [
            'Task #', 'Title', 'Project', 'Priority', 'Status',
            'Assigned To', 'Assigned By', 'Assigned Date', 'Due Date',
            'Completed Date', 'Overdue?', 'Verification'
        ];
        const taskHeaderRow = wsTasks.addRow(taskHeaders);
        applyHeaderStyle(taskHeaderRow, '1E40AF');

        tasks.forEach((t, idx) => {
            const statusStr = t.status_name || 'Pending';
            const isCompleted = ['completed', '2'].includes(String(statusStr).toLowerCase());
            const verificationStr = isCompleted ? (t.is_verified ? `Verified by ${t.verifier_name || 'Manager'}` : 'Awaiting Verification') : 'N/A';

            const formatDate = (dStr) => {
                if (!dStr) return '';
                const d = new Date(dStr);
                return isNaN(d.getTime()) ? dStr : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            };

            const row = wsTasks.addRow([
                `#${t.task_number || t.id}`,
                t.title,
                t.project_name || 'Self Task',
                t.priority_name || 'Medium',
                statusStr,
                t.assigned_name || 'Unassigned',
                t.creator_name || 'System',
                formatDate(t.created_at),
                formatDate(t.due_date),
                formatDate(t.completed_at),
                t.is_overdue ? 'YES' : 'No',
                verificationStr
            ]);

            applyDataStyle(row, idx % 2 === 1);

            // Center align specific columns
            row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(9).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(10).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(11).alignment = { vertical: 'middle', horizontal: 'center' };

            // Status Cell Color Coding
            const statusCell = row.getCell(5);
            const statusLower = String(statusStr).toLowerCase();
            if (statusLower === 'completed') {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DCFCE7' } };
                statusCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: '15803D' } };
            } else if (statusLower === 'in progress') {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F2FE' } };
                statusCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: '0369A1' } };
            } else if (statusLower === 'pending') {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF9C3' } };
                statusCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'B45309' } };
            }

            // Overdue Cell Color Coding
            if (t.is_overdue) {
                const overdueCell = row.getCell(11);
                overdueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                overdueCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'B91C1C' } };
            }
        });

        wsTasks.columns = [
            { width: 12 }, { width: 35 }, { width: 22 },
            { width: 14 }, { width: 16 }, { width: 24 },
            { width: 20 }, { width: 15 }, { width: 15 },
            { width: 16 }, { width: 12 }, { width: 26 }
        ];


        // ─── SHEET 3: Employee Workload ──────────────────────────────────────
        const wsEmp = workbook.addWorksheet('Employee Workload');
        wsEmp.views = [{ showGridLines: true }];

        const empHeaderRow = wsEmp.addRow([
            'Employee Name', 'Designation', 'Total Assigned Tasks',
            'Completed Tasks', 'In Progress Tasks', 'Pending Tasks',
            'Overdue Tasks', 'Completion Rate (%)'
        ]);
        applyHeaderStyle(empHeaderRow, '0D9488'); // Teal header

        employees.forEach((e, idx) => {
            const total = Number(e.total_assigned || 0);
            const done = Number(e.completed || 0);
            const rate = total ? Math.round((done / total) * 100) : 0;

            const row = wsEmp.addRow([
                e.label,
                e.designation || 'N/A',
                total,
                done,
                Number(e.in_progress || 0),
                Number(e.pending || 0),
                Number(e.overdue || 0),
                `${rate}%`
            ]);
            applyDataStyle(row, idx % 2 === 1);

            row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' };
        });

        wsEmp.columns = [
            { width: 25 }, { width: 20 }, { width: 22 },
            { width: 18 }, { width: 20 }, { width: 16 },
            { width: 16 }, { width: 22 }
        ];


        // ─── SHEET 4: Project Performance ────────────────────────────────────
        const wsProj = workbook.addWorksheet('Project Performance');
        wsProj.views = [{ showGridLines: true }];

        const projHeaderRow = wsProj.addRow([
            'Project Name', 'Manager Name', 'Total Tasks',
            'Completed Tasks', 'Progress Rate (%)', 'Status'
        ]);
        applyHeaderStyle(projHeaderRow, '6D28D9'); // Purple header

        projects.forEach((p, idx) => {
            const total = Number(p.total_tasks || 0);
            const done = Number(p.completed_tasks || 0);
            const pct = total ? Math.round((done / total) * 100) : 0;
            const statusStr = pct === 100 ? 'Completed' : (pct > 0 ? 'In Progress' : 'Not Started');

            const row = wsProj.addRow([
                p.label,
                p.manager_name || 'N/A',
                total,
                done,
                `${pct}%`,
                statusStr
            ]);
            applyDataStyle(row, idx % 2 === 1);

            row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };
        });

        wsProj.columns = [
            { width: 28 }, { width: 24 }, { width: 16 },
            { width: 18 }, { width: 20 }, { width: 16 }
        ];


        // Dynamic & Unique Filename Construction (Project Name + Date + Exact Time)
        let scopeName = 'All_Projects';
        if (selectedProject && projects.length > 0) {
            scopeName = String(projects[0].label || 'Project').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
        }

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;

        const filename = `TVA_Report_${scopeName}_${dateStr}_${timeStr}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Excel Error:', err);
        if (typeof next === 'function') next(err);
        else res.status(500).send('Failed to generate report Excel: ' + err.message);
    }
};
