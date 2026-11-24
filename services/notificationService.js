const { db } = require('../database/init');

async function notify(userId, message, link='', createdBy=null) {
    if (!userId) return;
    const targetIds = String(userId).split(',').map(x => Number(x.trim())).filter(Boolean);
    const validCreatedBy = (createdBy && Number(createdBy)) ? Number(createdBy) : null;
    for (const uid of targetIds) {
        try {
            await db.prepare('INSERT INTO notifications(user_id,message,link,created_by) VALUES(?,?,?,?)').run(uid, message, link, validCreatedBy);
        } catch(e) {
            console.error('Notification insert error:', e);
        }
    }
}

async function notifyOnce(userId, message, link='', createdBy=null) {
    if (!userId) return;
    const targetIds = String(userId).split(',').map(x => Number(x.trim())).filter(Boolean);
    const validCreatedBy = (createdBy && Number(createdBy)) ? Number(createdBy) : null;
    for (const uid of targetIds) {
        try {
            const exists = await db.prepare('SELECT id FROM notifications WHERE user_id=? AND message=? AND link=? LIMIT 1').get(uid, message, link);
            if (!exists) await notify(uid, message, link, validCreatedBy);
        } catch(e) {
            console.error('Notification once error:', e);
        }
    }
}

let lastSyncTime = 0;

async function syncOverdue(){
    try {
        const now = Date.now();
        if (now - lastSyncTime < 10 * 60 * 1000) return;
        lastSyncTime = now;

        const tasks=await db.prepare("SELECT t.id,t.title,t.assigned_to,t.created_by,COALESCE(u.name, 'Employee') employee_name FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.due_date<CURDATE() AND t.status NOT IN ('Completed','Cancelled','2','3') AND COALESCE(t.status_id, 0) NOT IN (2, 3)").all();
        for(const task of tasks){const link=`/tasks/${task.id}`;await notifyOnce(task.assigned_to,`URGENT: Task overdue - ${task.title}. Please complete it immediately.`,link,task.created_by);await notifyOnce(task.created_by,`Task overdue: ${task.title} assigned to ${task.employee_name}.`,link,task.assigned_to);}
        const projects=await db.prepare("SELECT id,name,manager_id,created_by FROM projects WHERE end_date<CURDATE() AND status NOT IN ('Completed','Cancelled','2','3') AND COALESCE(status_id, 0) NOT IN (2, 3)").all();
        for(const project of projects){const link=`/projects/${project.id}`;await notifyOnce(project.manager_id,`URGENT: Project overdue - ${project.name}. Please send an update to admin.`,link,project.created_by);await notifyOnce(project.created_by,`Project overdue: ${project.name}. Manager action is required.`,link,project.manager_id);}
    } catch(e) { console.error('syncOverdue error:', e); }
}

async function checkTaskReminders() {
    try {
        const activeReminders = await db.prepare(`
            SELECT r.*, t.title as task_title, t.task_number, t.status as task_status,
                   u_creator.name as creator_name
            FROM task_reminders r
            JOIN tasks t ON t.id = r.task_id
            LEFT JOIN users u_creator ON u_creator.id = r.user_id
            WHERE r.is_active = 1
              AND t.status NOT IN ('Completed', 'Cancelled', '2', '3')
              AND COALESCE(t.status_id, 0) NOT IN (2, 3)
        `).all();

        if (!activeReminders || activeReminders.length === 0) return;

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const todayYMD = `${year}-${month}-${day}`;

        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const currentHM = `${hours}:${minutes}`;
        const dayOfWeek = String(now.getDay()); // 0=Sun, 1=Mon, ..., 6=Sat

        for (const rem of activeReminders) {
            let lastDate = '';
            if (rem.last_sent_date) {
                if (rem.last_sent_date instanceof Date) {
                    const ly = rem.last_sent_date.getFullYear();
                    const lm = String(rem.last_sent_date.getMonth() + 1).padStart(2, '0');
                    const ld = String(rem.last_sent_date.getDate()).padStart(2, '0');
                    lastDate = `${ly}-${lm}-${ld}`;
                } else {
                    lastDate = String(rem.last_sent_date).slice(0, 10);
                }
            }
            if (lastDate === todayYMD) {
                continue; // Already notified today
            }

            const remHM = String(rem.remind_time || '10:00:00').slice(0, 5);
            if (currentHM < remHM) {
                continue; // Not yet time today
            }

            let shouldSend = false;
            if (rem.reminder_type === 'once') {
                let remDateStr = '';
                if (rem.remind_date) {
                    if (rem.remind_date instanceof Date) {
                        const ry = rem.remind_date.getFullYear();
                        const rm = String(rem.remind_date.getMonth() + 1).padStart(2, '0');
                        const rd = String(rem.remind_date.getDate()).padStart(2, '0');
                        remDateStr = `${ry}-${rm}-${rd}`;
                    } else {
                        remDateStr = String(rem.remind_date).slice(0, 10);
                    }
                }
                if (remDateStr && todayYMD >= remDateStr) {
                    shouldSend = true;
                }
            } else if (rem.reminder_type === 'daily') {
                shouldSend = true;
            } else if (rem.reminder_type === 'weekly') {
                const daysList = String(rem.days_of_week || '').split(',').map(d => d.trim());
                if (daysList.includes(dayOfWeek)) {
                    shouldSend = true;
                }
            }

            if (shouldSend) {
                const link = `/tasks/${rem.task_id}`;
                const taskDisplay = rem.task_number ? `#${rem.task_number} ${rem.task_title}` : rem.task_title;
                const message = rem.custom_message && rem.custom_message.trim()
                    ? `⏰ Task Reminder: ${taskDisplay} - "${rem.custom_message.trim()}"`
                    : `⏰ Pending Task Reminder: "${taskDisplay}" is still pending. Please take action.`;

                await notify(rem.notify_user_id, message, link, rem.user_id);

                await db.prepare('UPDATE task_reminders SET last_sent_at=NOW(), last_sent_date=? WHERE id=?').run(todayYMD, rem.id);

                if (rem.reminder_type === 'once') {
                    await db.prepare('UPDATE task_reminders SET is_active=0 WHERE id=?').run(rem.id);
                }
            }
        }
    } catch(err) {
        console.error('checkTaskReminders error:', err);
    }
}

module.exports = { notify, notifyOnce, syncOverdue, checkTaskReminders };

