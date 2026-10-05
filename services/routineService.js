const { db, createTaskAtomic } = require('../database/init');
const notifications = require('./notificationService');

let lastRoutineSyncDay = '';

async function syncDailyRoutines() {
    try {
        const todayStr = new Date().toISOString().slice(0, 10);
        // Avoid re-running sync on every single HTTP request if already done today
        if (lastRoutineSyncDay === todayStr) return;
        lastRoutineSyncDay = todayStr;

        const activeRoutines = await db.prepare(`
            SELECT * FROM daily_routines 
            WHERE active = 1 
              AND CURDATE() >= start_date 
              AND CURDATE() <= end_date
        `).all();

        for (const routine of activeRoutines) {
            const existingTask = await db.prepare(`
                SELECT id FROM tasks 
                WHERE routine_id = ? AND due_date = CURDATE()
                LIMIT 1
            `).get(routine.id);

            if (!existingTask) {
                const orgId = routine.organization_id || 1;
                const taskCreationResult = await createTaskAtomic({
                    organization_id: orgId,
                    project_id: routine.project_id,
                    title: routine.title,
                    description: routine.description || 'Daily Routine Task',
                    priority: routine.priority || 'High',
                    priority_id: 2,
                    status: 'Pending',
                    status_id: 0,
                    due_date: todayStr,
                    created_by: routine.created_by,
                    assigned_to: routine.assigned_to,
                    estimated_hours: routine.estimated_hours || 0,
                    is_self_task: 0
                });

                const taskId = taskCreationResult.id;

                // Mark task as routine
                await db.prepare('UPDATE tasks SET routine_id=?, is_routine=1 WHERE id=?').run(routine.id, taskId);

                // Insert into task_assignees so queries checking assignees pick it up instantly
                await db.prepare('INSERT IGNORE INTO task_assignees(task_id, user_id, status, status_id) VALUES(?,?,?,?)')
                    .run(taskId, routine.assigned_to, 0, 0);

                // Log execution event in database
                await db.prepare(`
                    INSERT INTO daily_routine_logs
                    (routine_id, task_id, assigned_to, execution_date, status)
                    VALUES (?, ?, ?, CURDATE(), 'Generated')
                `).run(routine.id, taskId, routine.assigned_to);

                await notifications.notifyOnce(
                    routine.assigned_to,
                    `Daily Routine Assigned for Today: ${routine.title}. Please complete this task first.`,
                    `/tasks/${taskId}`,
                    routine.created_by
                );
            }
        }
    } catch (err) {
        console.error('Error syncing daily routines:', err);
    }
}

async function updateRoutineLogStatus(taskId, status) {
    try {
        const logStatus = status === 'Completed' ? 'Completed' : status === 'In Progress' ? 'In Progress' : 'Generated';
        await db.prepare(`
            UPDATE daily_routine_logs 
            SET status = ?, completed_at = ? 
            WHERE task_id = ?
        `).run(logStatus, status === 'Completed' ? new Date() : null, taskId);
    } catch (err) {
        console.error('Error updating routine log status:', err);
    }
}

module.exports = {
    syncDailyRoutines,
    updateRoutineLogStatus
};
