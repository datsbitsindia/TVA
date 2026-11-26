const { db } = require('../database/init');

/**
 * Calculates Corporate CIBIL / Reliability Score (300 to 900) based on task performance metrics:
 * 1. Base Score: 650 (Neutral baseline)
 * 2. On-Time Completion Rate: Impact from -120 to +130 pts
 * 3. Quality / Manager Verification ("Verified without rework"): Up to +60 pts bonus
 * 4. Overdue Task Drag: -22 pts per active overdue task (up to -160 pts)
 * 5. Manager Rejection / Rework Penalty: -15 pts per rejection/unverify (up to -100 pts)
 * 6. Delivery Volume: +2 pts per completed task (up to +45 pts)
 */
function calculateReliabilityScore(stats) {
    const total = Number(stats.total_tasks || 0);
    const completed = Number(stats.completed_tasks || 0);
    const onTime = Number(stats.on_time_tasks || 0);
    const verified = Number(stats.verified_tasks || 0);
    const verifiedClean = Number(stats.verified_clean_tasks || 0);
    const overdue = Number(stats.overdue_tasks || 0);
    const rejections = Number(stats.rejection_count || 0);

    if (total === 0) {
        return {
            score: 650,
            tier: 'New Joiner',
            tierColor: '#64748b',
            tierBg: '#f1f5f9',
            isNew: true,
            rank: null,
            isTopPerformer: false,
            totalTasks: 0,
            completedTasks: 0,
            onTimeTasks: 0,
            verifiedTasks: 0,
            verifiedCleanTasks: 0,
            overdueTasks: 0,
            rejectionCount: 0,
            onTimeRate: 0,
            verificationRate: 0,
            factors: {
                base: 650,
                onTimeDelta: 0,
                qualityBonus: 0,
                overduePenalty: 0,
                rejectionPenalty: 0,
                volumeBonus: 0
            }
        };
    }

    const base = 650;

    // 1. On-time delivery impact (-120 to +130)
    const onTimeRatio = completed > 0 ? (onTime / completed) : 0;
    let onTimeDelta = Math.round((onTimeRatio - 0.6) * 220);
    onTimeDelta = Math.max(-120, Math.min(130, onTimeDelta));

    // 2. Manager Verified Quality Bonus (extra weight for verified without rework, up to +60)
    const verifiedRatio = completed > 0 ? (verifiedClean / completed) : 0;
    const reworkVerified = Math.max(0, verified - verifiedClean);
    const qualityBonus = Math.min(60, Math.round(verifiedRatio * 40) + (verifiedClean * 8) + (reworkVerified * 4));

    // 3. Overdue penalty (uncompleted tasks past due date, up to -160)
    const overduePenalty = Math.min(160, overdue * 22);

    // 4. Manager rejection / rework penalty (-15 pts per rejection, up to -100)
    const rejectionPenalty = Math.min(100, rejections * 15);

    // 5. Volume consistency (+2 per completed task, up to +45)
    const volumeBonus = Math.min(45, completed * 2);

    // Calculate final score bounded between 300 and 900
    let finalScore = base + onTimeDelta + qualityBonus + volumeBonus - overduePenalty - rejectionPenalty;
    finalScore = Math.max(300, Math.min(900, Math.round(finalScore)));

    let tier = 'Moderate';
    let tierColor = '#b45309';
    let tierBg = '#fef3c7';

    if (finalScore >= 800) {
        tier = 'Exceptional';
        tierColor = '#15803d';
        tierBg = '#dcfce7';
    } else if (finalScore >= 720) {
        tier = 'Very Reliable';
        tierColor = '#059669';
        tierBg = '#d1fae5';
    } else if (finalScore >= 650) {
        tier = 'Moderate';
        tierColor = '#b45309';
        tierBg = '#fef3c7';
    } else if (finalScore >= 520) {
        tier = 'Needs Improvement';
        tierColor = '#ea580c';
        tierBg = '#ffedd5';
    } else {
        tier = 'Critical Attention';
        tierColor = '#dc2626';
        tierBg = '#fee2e2';
    }

    return {
        score: finalScore,
        tier,
        tierColor,
        tierBg,
        isNew: false,
        rank: null,
        isTopPerformer: false,
        totalTasks: total,
        completedTasks: completed,
        onTimeTasks: onTime,
        verifiedTasks: verified,
        verifiedCleanTasks: verifiedClean,
        overdueTasks: overdue,
        rejectionCount: rejections,
        onTimeRate: completed > 0 ? Math.round((onTime / completed) * 100) : 0,
        verificationRate: completed > 0 ? Math.round((verified / completed) * 100) : 0,
        factors: {
            base,
            onTimeDelta,
            qualityBonus,
            overduePenalty,
            rejectionPenalty,
            volumeBonus
        }
    };
}

async function getOrganizationReliabilityScores(orgId) {
    try {
        const stats = await db.prepare(`
            SELECT u.id, u.name, u.role, u.active,
                COUNT(DISTINCT t.id) as total_tasks,
                COUNT(DISTINCT CASE WHEN LOWER(COALESCE(
                    (SELECT name FROM statuses WHERE id = ta.status_id LIMIT 1),
                    (SELECT name FROM statuses WHERE id = ta.status LIMIT 1),
                    (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
                    t.status, 'Pending'
                )) IN ('completed', '2') THEN t.id END) as completed_tasks,
                COUNT(DISTINCT CASE WHEN LOWER(COALESCE(
                    (SELECT name FROM statuses WHERE id = ta.status_id LIMIT 1),
                    (SELECT name FROM statuses WHERE id = ta.status LIMIT 1),
                    (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
                    t.status, 'Pending'
                )) IN ('completed', '2') AND (DATE(COALESCE(ta.completed_at, t.completed_at)) <= t.due_date OR t.due_date IS NULL) THEN t.id END) as on_time_tasks,
                COUNT(DISTINCT CASE WHEN t.is_verified = 1 THEN t.id END) as verified_tasks,
                COUNT(DISTINCT CASE WHEN t.is_verified = 1 AND COALESCE(t.rejection_count, 0) = 0 THEN t.id END) as verified_clean_tasks,
                COALESCE(SUM(COALESCE(t.rejection_count, 0)), 0) as rejection_count,
                COUNT(DISTINCT CASE WHEN t.due_date < CURDATE() AND LOWER(COALESCE(
                    (SELECT name FROM statuses WHERE id = ta.status_id LIMIT 1),
                    (SELECT name FROM statuses WHERE id = ta.status LIMIT 1),
                    (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
                    t.status, 'Pending'
                )) NOT IN ('completed', 'cancelled', '2', '3') THEN t.id END) as overdue_tasks
            FROM users u
            LEFT JOIN tasks t ON (FIND_IN_SET(u.id, REPLACE(t.assigned_to, ' ', '')) > 0 OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id = u.id))
            LEFT JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = u.id
            WHERE (u.organization_id = ? OR u.id IN (SELECT user_id FROM user_organizations WHERE organization_id = ?))
            GROUP BY u.id, u.name, u.role, u.active
        `).all(orgId, orgId);

        // Compute scores and prepare leaderboard ranking among active members with tasks (employee/manager)
        const scoresMap = {};
        const rankable = [];
        for (const s of stats) {
            const rel = calculateReliabilityScore(s);
            scoresMap[s.id] = rel;
            if (s.active && (s.role === 'employee' || s.role === 'manager') && rel.completedTasks > 0) {
                rankable.push({ id: s.id, name: s.name, role: s.role, score: rel.score, completed: rel.completedTasks });
            }
        }

        rankable.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.completed - a.completed;
        });

        rankable.forEach((item, idx) => {
            if (scoresMap[item.id]) {
                scoresMap[item.id].rank = idx + 1;
                scoresMap[item.id].isTopPerformer = idx === 0;
            }
        });

        return scoresMap;
    } catch (err) {
        console.error('Error computing reliability scores:', err);
        return {};
    }
}

module.exports = {
    calculateReliabilityScore,
    getOrganizationReliabilityScores
};
