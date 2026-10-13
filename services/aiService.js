const { GoogleGenAI } = require('@google/genai');
const config = require('../config');

// Initialize Gemini Client
const apiKey = process.env.GEMINI_API_KEY || config.geminiApiKey || '';
const aiClient = apiKey ? new GoogleGenAI({ apiKey }) : null;

// Python FastMCP Service URL
const PYTHON_MCP_URL = process.env.PYTHON_MCP_URL || 'http://localhost:8000';

// Cache for tools declaration
let cachedToolsDeclaration = null;

// Helper to format raw tool result to natural text if AI follow-up fails
function formatToolResultToText(toolName, result, currentUser) {
    if (!result) return "Task processed successfully.";
    if (result.error) return `⚠️ Error: ${result.error}`;
    if (result.message) return result.message;

    if (result.tasks && Array.isArray(result.tasks)) {
        if (result.tasks.length === 0) return "No tasks found matching this filter.";

        const currentUserName = (currentUser && currentUser.name) ? currentUser.name.toLowerCase() : '';
        const currentUserId = (currentUser && currentUser.id) ? String(currentUser.id) : '';

        const todoTasks = [];
        const assignedOutTasks = [];

        result.tasks.forEach(t => {
            const assignees = (t.assigned_to_names || '').toLowerCase();
            const rawAssignees = String(t.assigned_to || '');
            const isAssignedToMe = (currentUserName && assignees.includes(currentUserName)) || (currentUserId && rawAssignees.split(',').includes(currentUserId));
            
            if (isAssignedToMe) {
                todoTasks.push(t);
            } else {
                assignedOutTasks.push(t);
            }
        });

        let reply = `Found ${result.tasks.length} task(s):\n\n`;

        if (todoTasks.length > 0) {
            reply += `📋 **To Do Tasks (Assigned to You - ${todoTasks.length}):**\n`;
            todoTasks.forEach((t, i) => {
                reply += `${i + 1}. **${t.title}** (ID: #${t.id})\n   - Status: ${t.status_str || t.status} | Priority: ${t.priority_str || t.priority}\n   - Assigned Date: ${t.created_at || 'N/A'} | Due Date: ${t.due_date}\n`;
            });
            reply += `\n`;
        }

        if (assignedOutTasks.length > 0) {
            reply += `📤 **Assigned Out Tasks (Assigned to Others - ${assignedOutTasks.length}):**\n`;
            assignedOutTasks.forEach((t, i) => {
                reply += `${i + 1}. **${t.title}** (ID: #${t.id})\n   - Assigned To: ${t.assigned_to_names || 'Unassigned'}\n   - Status: ${t.status_str || t.status} | Priority: ${t.priority_str || t.priority}\n   - Assigned Date: ${t.created_at || 'N/A'} | Due Date: ${t.due_date}\n`;
            });
        }

        return reply.trim();
    }
    if (result.task && typeof result.task === 'object') {
        const t = result.task;
        return `Task #${t.id} Details:\n- **Title:** ${t.title}\n- **Status:** ${t.status_str || t.status}\n- **Priority:** ${t.priority_str || t.priority}\n- **Assigned To:** ${t.assigned_to_names || 'None'}\n- **Due Date:** ${t.due_date || 'N/A'}`;
    }
    if (result.team && Array.isArray(result.team)) {
        let reply = `Team Members (${result.team.length}):\n`;
        result.team.forEach(m => {
            reply += `- **${m.name}** (${m.email}) - ${m.role} (${m.department || ''})\n`;
        });
        return reply;
    }
    if (result.overdue_tasks && Array.isArray(result.overdue_tasks)) {
        if (result.overdue_tasks.length === 0) return "Great news! You have no overdue tasks.";
        let reply = `⚠️ Overdue Tasks (${result.overdue_tasks.length}):\n`;
        result.overdue_tasks.forEach(t => {
            reply += `- **${t.title}** (ID: #${t.id}) - Due: ${t.due_date}\n`;
        });
        return reply;
    }
    if (result.productivity) {
        const p = result.productivity;
        return `Productivity Summary:\n- Total Assigned: ${p.total_assigned_tasks}\n- Completed: ${p.completed_tasks}\n- Overdue: ${p.overdue_tasks}\n- Completion Rate: ${p.completion_rate_percentage}%\n- Score: ${p.performance_score}`;
    }
    if (result.project && typeof result.project === 'object') {
        const p = result.project;
        return `✅ **Project '${p.name}' (ID: #${p.id}) created successfully!**\n- **Status:** ${p.status}\n- **Description:** ${p.description}\n- **Start Date:** ${p.start_date || 'Immediate'}\n- **End Date:** ${p.end_date || 'Flexible'}`;
    }
    if (result.completion_rate_percentage !== undefined && result.project_name) {
        return `📊 **Project Health Report: ${result.project_name}**\n- **Status:** ${result.status}\n- **Managers:** ${result.managers && result.managers.length > 0 ? result.managers.join(', ') : 'None'}\n- **Completion Rate:** ${result.completion_rate_percentage}%\n- **Total Tasks:** ${result.total_tasks}\n- **Completed:** ${result.completed_tasks} | **In Progress:** ${result.in_progress_tasks} | **Pending:** ${result.pending_tasks}\n- **Overdue Tasks:** ⚠️ ${result.overdue_tasks}`;
    }
    if (result.delayed_projects && Array.isArray(result.delayed_projects)) {
        if (result.delayed_projects.length === 0) return "🎉 Excellent news! No active projects are currently delayed or lagging behind schedule.";
        let reply = `⚠️ **Delayed & At-Risk Projects (${result.delayed_projects.length}):**\n\n`;
        result.delayed_projects.forEach((dp, i) => {
            reply += `${i + 1}. **${dp.name}** (ID: #${dp.id})\n   - Overdue Tasks: ${dp.overdue_tasks_count}\n   - Target End Date: ${dp.end_date || 'N/A'} ${dp.is_past_deadline ? '🔴 (Past Deadline!)' : ''}\n`;
        });
        return reply.trim();
    }
    return typeof result === 'string' ? result : JSON.stringify(result);
}

// Fetch tool schemas dynamically from Python FastMCP Server
async function fetchDynamicToolsDeclaration() {
    if (cachedToolsDeclaration && cachedToolsDeclaration.length > 0) {
        return cachedToolsDeclaration;
    }
    try {
        const response = await fetch(`${PYTHON_MCP_URL}/tools_schema`);
        if (response.ok) {
            const data = await response.json();
            if (data.functionDeclarations && data.functionDeclarations.length > 0) {
                cachedToolsDeclaration = [{ functionDeclarations: data.functionDeclarations }];
                return cachedToolsDeclaration;
            }
        }
    } catch (err) {
        console.warn('Could not fetch dynamic tools from Python FastMCP server, using fallback schema:', err.message);
    }
    return cachedToolsDeclaration || [];
}

// Normalize JSON Schema types from Gemini format (UPPERCASE) to Groq/OpenAI JSON Schema (lowercase draft-07)
function normalizeJsonSchemaForGroq(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(normalizeJsonSchemaForGroq);

    const newObj = {};
    for (const key of Object.keys(obj)) {
        if (key === 'type' && typeof obj[key] === 'string') {
            newObj[key] = obj[key].toLowerCase();
        } else {
            newObj[key] = normalizeJsonSchemaForGroq(obj[key]);
        }
    }

    if (newObj.properties && typeof newObj.properties === 'object') {
        const requiredList = Array.isArray(newObj.required) ? newObj.required : [];
        for (const propName of Object.keys(newObj.properties)) {
            if (!requiredList.includes(propName)) {
                const prop = newObj.properties[propName];
                if (prop && prop.type && prop.type !== 'array' && prop.type !== 'object') {
                    prop.type = [prop.type, 'null'];
                }
            }
        }
    }
    return newObj;
}

// Tool Execution Handler - Delegates execution to Python FastMCP Server
async function executeTool(toolName, args, user) {
    try {
        // Clean null argument values before passing to Python FastMCP
        const cleanedArgs = { ...(args || {}) };
        for (const k of Object.keys(cleanedArgs)) {
            if (cleanedArgs[k] === null) delete cleanedArgs[k];
        }

        const response = await fetch(`${PYTHON_MCP_URL}/call_tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tool_name: toolName,
                args: cleanedArgs,
                user: { id: user.id, name: user.name, role: user.role }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`Python FastMCP Call Failed (${response.status}):`, errText);
            return { error: `Python FastMCP Server Error: ${response.statusText}` };
        }

        const data = await response.json();
        if (data.success) {
            return data.result;
        } else {
            return { error: data.error || 'Failed to execute tool on Python FastMCP Server.' };
        }
    } catch (err) {
        console.error('AI Tool Execution Error (Python FastMCP Connection):', err);
        return { error: `Python FastMCP connection failed: ${err.message}. Make sure Python FastMCP server is running on port 8000.` };
    }
}

// OpenRouter API Provider Handler (Unlimited Free AI Models)
async function processWithOpenRouter(user, message, existingHistory, toolsDeclaration, projectContextStr, teamContextStr) {
    const openrouterKey = process.env.OPENROUTER_API_KEY || config.openrouterApiKey || '';
    if (!openrouterKey) return null;

    const openrouterTools = (toolsDeclaration?.[0]?.functionDeclarations || []).map(fn => ({
        type: "function",
        function: {
            name: fn.name,
            description: fn.description,
            parameters: normalizeJsonSchemaForGroq(fn.parameters)
        }
    }));

    const messages = [
        {
            role: "system",
            content: `You are TVA AI Assistant - Dedicated Task Management Agent for logged-in user: ${user.name} (Role: ${user.role}).

REAL DATABASE CONTEXT (LIVE INJECTED FROM MYSQL):
- VALID REAL ACTIVE PROJECTS IN DATABASE: [${projectContextStr || 'AdwaitShakti'}]
- VALID REAL TEAM MEMBERS IN DATABASE: [${teamContextStr || 'Bhavin, Jemini, Chintan, Chetan'}]

CORE DOMAIN SCOPE & STRICT TASK/PROJECT BOUNDARY:
- You are 100% EXCLUSIVELY a Project & Task Management Assistant for TVA (Task & Velocity Administration).
- Your functions include handling Tasks and Projects (creating tasks, searching tasks, updating status, reassigning tasks, adding comments, task & productivity reports, creating projects, and project health reports).
- STRICTLY REJECT ALL GENERAL KNOWLEDGE QUESTIONS (e.g. politics, prime ministers, sports, weather, trivia, recipes, general chat).
- If the user asks ANY question outside of Task & Project Management (e.g. "Who is the Prime Minister of India?", "What is the capital of France?", "Tell me a joke"), respond STRICTLY with:
  "I'm sorry, but I can only help with task and project-related requests such as creating, updating, or viewing tasks and projects. Let me know if you need assistance with any of your work!"

CRITICAL LANGUAGE & SCRIPT RULE:
- ALWAYS write all responses using English / Latin letters ONLY (e.g. "Abhi aapke To Do tab mein koi pending task nahi hai").
- NEVER use Devanagari script or Hindi characters (like "अभी आपके लिए...").

OPERATIONAL PROJECT & TASK RULES:
1. PROJECT CREATION PERMISSION RULE (STRICT ADMIN ACCESS):
   - Current user role is: '${user.role}'.
   - ONLY 'admin' role has permission to create and assign new projects!
   - If user asks to create/assign a project and user.role is NOT 'admin':
     * If user.role is 'user' or 'employee', immediately reply: "⚠️ Access Denied: Only Admins have permission to create new projects."
     * If user.role is 'manager', immediately reply: "⚠️ Access Denied: Only Admins have permission to create new projects. As a Manager, you can view project progress & health reports."
   - If user.role IS 'admin', invoke create_new_project(name, user_id, user_role, description, start_date, end_date, manager_name_or_email).
2. PROJECT HEALTH & PROGRESS REPORTS (ADMIN & MANAGER ACCESS):
   - Both Admin and Manager can request project details, completion %, and health reports via get_project_health_report(project_name, user_id, user_role).
   - Both Admin and Manager can ask which projects are lagging behind or overdue via get_delayed_projects(user_id, user_role).
3. AUTOMATIC TASK LOOKUP (NEVER ASK USER FOR TASK ID):
   - NEVER ask the user for a Task ID! End-users do not know database IDs.
   - When a user asks to update, complete, delete, reassign, or add a comment to a task by title, ALWAYS call get_user_tasks first to search the database, find the Task ID, and then perform the action!
4. TASK CREATION CLARIFICATION:
   - When a user asks to create a task, check if essential details (title, assignee, due date, priority) are provided.
   - If essential fields are missing, ask polite clarifying questions before invoking create_new_task, or suggest reasonable defaults and confirm with user.
   - If user mentions an employee name (e.g. "Assign to Bhavin"), call get_team_members first to verify the exact person.
3. STRICT ACTIVE PROJECT & HALLUCINATION PREVENTION RULE:
   - Tasks CAN ONLY be assigned to the REAL ACTIVE PROJECTS listed above: [${projectContextStr || 'AdwaitShakti'}]!
   - NEVER invent, guess, or label a word (such as "videos", "photo", "demo", "meeting", "test", "DBMS", "adversity") as a project name unless it is explicitly in [${projectContextStr}]!
   - ONLY pass project_name to create_new_task IF the user explicitly specified a valid project name from [${projectContextStr}].
   - If the user specifies a non-existing project (e.g. "videos", "DBMS"), respond directly and politely:
     "Aisa koi active project exist nahi karta hai. Currently active projects ye hain: [${projectContextStr}]. Kripya inme se kisi active project par task add karein!"
   - When asking clarifying questions for missing task details, NEVER invent a project name like "videos". Ask: "Which project would you like to assign this task to? Active projects: [${projectContextStr}]."
   - "TVA" IS THE APPLICATION SYSTEM NAME (Task & Velocity Administration), NOT A PROJECT! NEVER assume "TVA" is a project name.
   - In your final message, ONLY report the exact project name returned by create_new_task tool! NEVER display a fake project name.
4. TASK STATUS PERMISSION RULE:
   - ONLY assigned team members (or Admin) can change a task's status or mark it Completed.
   - If a Manager/Creator asks to mark a task as Completed that is assigned to someone else (e.g. Jemini), pass user_id and user_role to update_task_status tool. If tool returns Permission Denied, explain politely that only the assigned employee (or Admin) can mark their assigned tasks as Completed.
5. DATE RANGE FILTERING RULE:
   - Current Date context: 2026-08-20.
   - When user asks for "tasks created in last N days", calculate start_date (e.g. 2026-08-18 for 3 days), set date_field='created_at', task_type='all', and call get_user_tasks.
   - When user asks for tasks within a date range (e.g. "between 14th August to 20th August"), convert dates to YYYY-MM-DD format (start_date='2026-08-14', end_date='2026-08-20') and call get_user_tasks with task_type='all'.
6. TEAM NAME MAPPING RULE:
   - Always spell team names as: Bhavin (never Bhabi/Bhabhi), Jemini (starts with J, never Gemini), Chintan, Chetan.
   - If user input contains misheard speech words like "Gemini" or "Bhabi", automatically map them to Jemini and Bhavin.
7. SINGLE / RECENT TASK RESPONSE RULE:
   - When the user asks for "the last task", "recent task", "latest task", or asks which specific task was created last, ONLY output the single 1 most recent task details. NEVER output the entire list of tasks.
8. NEVER output raw JSON. Always summarize tool results in friendly natural language.`
        },
        ...(existingHistory || []).map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content
        })),
        { role: "user", content: message }
    ];

    const openrouterModels = [
        'openai/gpt-oss-20b:free',
        'google/gemma-4-31b-it:free',
        'z-ai/glm-5.2:free'
    ];

    let lastError = null;

    for (const modelName of openrouterModels) {
        let loopCount = 0;
        let lastToolResult = null;

        while (loopCount < 4) {
            loopCount++;
            try {
                const body = {
                    model: modelName,
                    messages: messages,
                    temperature: 0.2
                };
                if (openrouterTools.length > 0) body.tools = openrouterTools;

                const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${openrouterKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://tva.datsbits.com",
                        "X-Title": "TVA Task Manager"
                    },
                    body: JSON.stringify(body)
                });

                if (!res.ok) {
                    const errText = await res.text();
                    console.warn(`OpenRouter model ${modelName} error (${res.status}):`, errText);
                    lastError = `OpenRouter (${res.status}): ${errText}`;
                    break;
                }

                const data = await res.json();
                const choice = data.choices?.[0]?.message;
                if (!choice) break;

                messages.push(choice);

                if (choice.tool_calls && choice.tool_calls.length > 0) {
                    const callObj = choice.tool_calls[0];
                    const call = callObj.function;
                    const toolCallId = callObj.id || `call_${Date.now()}`;
                    if (!callObj.id) callObj.id = toolCallId;

                    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : (call.arguments || {});
                    const toolResult = await executeTool(call.name, args, user);
                    lastToolResult = toolResult;

                    messages.push({
                        role: "tool",
                        tool_call_id: toolCallId,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                    });

                    continue;
                }

                const replyText = choice.content || choice.reasoning;
                if (replyText && String(replyText).trim()) {
                    return { reply: String(replyText).trim() };
                }

                if (lastToolResult) {
                    return { reply: formatToolResultToText(choice.tool_calls?.[0]?.function?.name || "tool", lastToolResult, user) };
                }
            } catch (err) {
                console.error(`OpenRouter model ${modelName} connection error:`, err);
                lastError = err.message;
                break;
            }
        }
    }

    return null;
}

// Groq API Provider Handler (Ultra-fast 14,400 free requests/day with multi-step tool loop)
async function processWithGroq(user, message, existingHistory, toolsDeclaration, projectContextStr = 'AdwaitShakti', teamContextStr = 'Bhavin, Jemini, Chintan, Chetan') {
    const groqKey = process.env.GROQ_API_KEY || config.groqApiKey || '';
    if (!groqKey) return null;

    const groqTools = (toolsDeclaration?.[0]?.functionDeclarations || []).map(fn => ({
        type: "function",
        function: {
            name: fn.name,
            description: fn.description,
            parameters: normalizeJsonSchemaForGroq(fn.parameters)
        }
    }));

    const messages = [
        {
            role: "system",
            content: `You are TVA AI Assistant - Dedicated Task Management Agent for logged-in user: ${user.name} (Role: ${user.role}).

REAL DATABASE CONTEXT (LIVE INJECTED FROM MYSQL):
- VALID REAL ACTIVE PROJECTS IN DATABASE: [${projectContextStr || 'AdwaitShakti'}]
- VALID REAL TEAM MEMBERS IN DATABASE: [${teamContextStr || 'Bhavin, Jemini, Chintan, Chetan'}]

CORE DOMAIN SCOPE & STRICT TASK/PROJECT BOUNDARY:
- You are 100% EXCLUSIVELY a Project & Task Management Assistant for TVA (Task & Velocity Administration).
- Your functions include handling Tasks and Projects (creating tasks, searching tasks, updating status, reassigning tasks, adding comments, task & productivity reports, creating projects, and project health reports).
- STRICTLY REJECT ALL GENERAL KNOWLEDGE QUESTIONS (e.g. politics, prime ministers, sports, weather, trivia, recipes, general chat).

CRITICAL LANGUAGE & SCRIPT RULE:
- ALWAYS write all responses using English / Latin letters ONLY (e.g. "Abhi aapke To Do tab mein koi pending task nahi hai").
- NEVER use Devanagari script or Hindi characters.

OPERATIONAL PROJECT & TASK RULES:
1. PROJECT CREATION PERMISSION RULE (STRICT ADMIN ACCESS):
   - Current user role is: '${user.role}'.
   - ONLY 'admin' role has permission to create and assign new projects!
   - If user asks to create/assign a project and user.role is NOT 'admin':
     * If user.role is 'user' or 'employee', immediately reply: "⚠️ Access Denied: Only Admins have permission to create new projects."
     * If user.role is 'manager', immediately reply: "⚠️ Access Denied: Only Admins have permission to create new projects. As a Manager, you can view project progress & health reports."
   - If user.role IS 'admin', invoke create_new_project(name, user_id, user_role, description, start_date, end_date, manager_name_or_email).
2. PROJECT HEALTH & PROGRESS REPORTS (ADMIN & MANAGER ACCESS):
   - Both Admin and Manager can request project details, completion %, and health reports via get_project_health_report(project_name, user_id, user_role).
   - Both Admin and Manager can ask which projects are lagging behind or overdue via get_delayed_projects(user_id, user_role).
3. AUTOMATIC TASK LOOKUP (NEVER ASK USER FOR TASK ID):
   - NEVER ask the user for a Task ID! End-users do not know database IDs.
   - When a user asks to update, complete, delete, reassign, or add a comment to a task by title, ALWAYS call get_user_tasks first.
4. TASK CREATION CLARIFICATION:
   - When a user asks to create a task, check if essential details (title, assignee, due date, priority) are provided.
3. STRICT ACTIVE PROJECT & HALLUCINATION PREVENTION RULE:
   - Tasks CAN ONLY be assigned to the REAL ACTIVE PROJECTS listed above: [${projectContextStr || 'AdwaitShakti'}]!
   - NEVER invent, guess, or label a word (such as "videos", "photo", "demo", "meeting", "test", "DBMS", "adversity") as a project name unless it is explicitly in [${projectContextStr}]!
   - ONLY pass project_name to create_new_task IF the user explicitly specified a valid project name from [${projectContextStr}].
   - If the user specifies a non-existing project (e.g. "videos", "DBMS"), respond directly and politely:
     "Aisa koi active project exist nahi karta hai. Currently active projects ye hain: [${projectContextStr}]. Kripya inme se kisi active project par task add karein!"
   - When asking clarifying questions for missing task details, NEVER invent a project name like "videos". Ask: "Which project would you like to assign this task to? Active projects: [${projectContextStr}]."
   - "TVA" IS THE APPLICATION SYSTEM NAME (Task & Velocity Administration), NOT A PROJECT! NEVER assume "TVA" is a project name.
   - In your final message, ONLY report the exact project name returned by create_new_task tool! NEVER display a fake project name.`
        },
        ...(existingHistory || []).map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content
        })),
        { role: "user", content: message }
    ];

    // Official Groq Models with full tool-calling support
    const groqModels = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b'];
    let lastGroqError = null;

    for (const gModel of groqModels) {
        let loopCount = 0;
        let lastToolResult = null;

        while (loopCount < 4) {
            loopCount++;
            try {
                const body = {
                    model: gModel,
                    messages: messages,
                    temperature: 0.2
                };
                if (groqTools.length > 0) body.tools = groqTools;

                let res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${groqKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(body)
                });

                if (res.status === 429) {
                    console.warn(`Groq 429 rate limit on ${gModel}, auto retrying in 1.5s...`);
                    await new Promise(r => setTimeout(r, 1500));
                    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${groqKey}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(body)
                    });
                }

                if (!res.ok) {
                    const errText = await res.text();
                    lastGroqError = `Groq API (${res.status}): ${errText}`;
                    console.error(`Groq API Error (${res.status}) on ${gModel}:`, errText);
                    if (lastToolResult) return { reply: formatToolResultToText("tool", lastToolResult, user) };
                    break;
                }

                const data = await res.json();
                const choice = data.choices?.[0]?.message;
                if (!choice) break;

                messages.push(choice);

                // Check if LLM requested tool execution
                if (choice.tool_calls && choice.tool_calls.length > 0) {
                    const callObj = choice.tool_calls[0];
                    const call = callObj.function;
                    const toolCallId = callObj.id || `call_${Date.now()}`;
                    if (!callObj.id) callObj.id = toolCallId;

                    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : (call.arguments || {});
                    const toolResult = await executeTool(call.name, args, user);
                    lastToolResult = toolResult;

                    messages.push({
                        role: "tool",
                        tool_call_id: toolCallId,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                    });

                    // Continue loop so LLM can process toolResult and issue follow-up action or text!
                    continue;
                }

                // If LLM returned text response or reasoning, return it!
                const replyText = choice.content || choice.reasoning;
                if (replyText && String(replyText).trim()) {
                    return { reply: String(replyText).trim() };
                }

                if (lastToolResult) {
                    return { reply: formatToolResultToText(choice.tool_calls?.[0]?.function?.name || "tool", lastToolResult, user) };
                }
            } catch (err) {
                console.error(`Groq API Model ${gModel} Connection Error:`, err);
                lastGroqError = err.message;
                break;
            }
        }
    }

    if (lastGroqError) {
        return { reply: `Groq Error: ${lastGroqError}` };
    }

    return null; // Fallback to Gemini if all Groq models fail
}

// Process Chat Prompt with Conversation Context
async function processUserMessage(user, message, existingHistory = []) {
    const currentKey = process.env.GEMINI_API_KEY || config.geminiApiKey || '';
    const groqKey = process.env.GROQ_API_KEY || config.groqApiKey || '';
    const openrouterKey = process.env.OPENROUTER_API_KEY || config.openrouterApiKey || '';

    if (!currentKey && !groqKey && !openrouterKey) {
        return {
            reply: `⚠️ API Key configured nahi hai! Please .env file mein GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY add karein.`
        };
    }

    // Fetch dynamic tools schema from Python FastMCP
    const toolsDeclaration = await fetchDynamicToolsDeclaration();

    // Fetch live active projects and team members from DB to inject into system prompt
    let projectContextStr = 'AdwaitShakti';
    let teamContextStr = 'Bhavin, Jemini, Chintan, Chetan';
    try {
        const projRes = await executeTool('get_active_projects', { user_id: user.id, user_role: user.role || 'user' }, user);
        if (projRes && projRes.projects && Array.isArray(projRes.projects)) {
            const names = projRes.projects.map(p => p.name).filter(Boolean);
            if (names.length > 0) projectContextStr = names.join(', ');
        }
    } catch (e) { console.warn('Context fetch get_active_projects error:', e.message); }
    try {
        const teamRes = await executeTool('get_team_members', {}, user);
        if (teamRes && teamRes.members && Array.isArray(teamRes.members)) {
            const names = teamRes.members.map(m => m.name).filter(Boolean);
            if (names.length > 0) teamContextStr = names.join(', ');
        }
    } catch (e) { console.warn('Context fetch get_team_members error:', e.message); }

    // Priority 1: Try OpenRouter API first
    if (openrouterKey) {
        const openrouterResult = await processWithOpenRouter(user, message, existingHistory, toolsDeclaration, projectContextStr, teamContextStr);
        if (openrouterResult) return openrouterResult;
    }

    // Priority 2: Try Groq API
    if (groqKey) {
        const groqResult = await processWithGroq(user, message, existingHistory, toolsDeclaration, projectContextStr, teamContextStr);
        if (groqResult) return groqResult;
    }

    // Priority 3: Fallback to Gemini SDK
    const geminiHistory = (existingHistory || []).map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
    }));

    const candidateModels = ['gemini-3.6-flash', 'gemini-3.5-flash'];
    let lastError = null;

    for (const mName of candidateModels) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const client = new GoogleGenAI({ apiKey: currentKey });

                const systemInstruction = `You are TVA AI Assistant - Dedicated Project & Task Management Agent for logged-in user: ${user.name} (Role: ${user.role}).

CORE DOMAIN SCOPE & STRICT TASK/PROJECT BOUNDARY:
- You are 100% EXCLUSIVELY a Project & Task Management Assistant for TVA (Task & Velocity Administration).
- Your ONLY functions are handling Tasks and Projects (creating/searching tasks, updating status, reassigning tasks, adding comments, task & productivity reports, creating projects, and project health reports).
- STRICTLY REJECT ALL GENERAL KNOWLEDGE QUESTIONS (e.g. politics, prime ministers, sports, weather, trivia, recipes, general chat).
- If the user asks ANY question outside of Task & Project Management (e.g. "Who is the Prime Minister of India?", "What is the capital of France?", "Tell me a joke"), respond STRICTLY with:
  "I'm sorry, but I can only help with task and project-related requests such as creating, updating, or viewing tasks and projects. Let me know if you need assistance with any of your work!"

CRITICAL LANGUAGE & SCRIPT RULE:
- ALWAYS write all responses using English / Latin letters ONLY (e.g. "Abhi aapke To Do tab mein koi pending task nahi hai").
- NEVER use Devanagari script or Hindi characters (like "अभी आपके लिए...").

OPERATIONAL PROJECT & TASK RULES:
1. PROJECT CREATION PERMISSION RULE (STRICT ADMIN ACCESS):
   - Current user role is: '${user.role}'.
   - ONLY 'admin' role has permission to create and assign new projects!
   - If user asks to create/assign a project and user.role is NOT 'admin':
     * If user.role is 'user' or 'employee', immediately reply: "⚠️ Access Denied: Only Admins have permission to create new projects."
     * If user.role is 'manager', immediately reply: "⚠️ Access Denied: Only Admins have permission to create new projects. As a Manager, you can view project progress & health reports."
   - If user.role IS 'admin', invoke create_new_project(name, user_id, user_role, description, start_date, end_date, manager_name_or_email).
2. PROJECT HEALTH & PROGRESS REPORTS (ADMIN & MANAGER ACCESS):
   - Both Admin and Manager can request project details, completion %, and health reports via get_project_health_report(project_name, user_id, user_role).
   - Both Admin and Manager can ask which projects are lagging behind or overdue via get_delayed_projects(user_id, user_role).
3. AUTOMATIC TASK LOOKUP (NEVER ASK USER FOR TASK ID):
   - NEVER ask the user for a Task ID! End-users do not know database IDs.
   - When a user asks to update, complete, delete, reassign, or add a comment to a task by title, ALWAYS call get_user_tasks first to search the database, find the Task ID, and then perform the action!
4. TASK CREATION CLARIFICATION:
   - When a user asks to create a task, check if essential details (title, assignee, due date, priority) are provided.
   - If essential fields are missing, ask polite clarifying questions before invoking create_new_task, or suggest reasonable defaults and confirm with user.
   - If user mentions an employee name (e.g. "Assign to Bhavin"), call get_team_members first to verify the exact person.
5. STRICT ACTIVE PROJECT & ERROR REPORTING RULE:
   - Tasks can ONLY be assigned to EXISTING ACTIVE / PENDING projects!
   - NEVER invent, guess, or hallucinate project names!
   - ONLY pass project_name to create_new_task IF the user explicitly specified a project name in their prompt.
   - If the user specifies a non-existing or completed project, respond directly and politely:
     "Aisa koi active project exist nahi karta hai. Currently active projects ye hain: [list active projects]. Kripya inme se kisi active project ka naam batayein!"
   - If a Manager/Creator asks to mark a task as Completed that is assigned to someone else (e.g. Jemini), pass user_id and user_role to update_task_status tool. If tool returns Permission Denied, explain politely that only the assigned employee (or Admin) can mark their assigned tasks as Completed.
5. DATE RANGE FILTERING RULE:
   - Current Date context: 2026-08-20.
   - When user asks for "tasks created in last N days", calculate start_date (e.g. 2026-08-18 for 3 days), set date_field='created_at', task_type='all', and call get_user_tasks.
   - When user asks for tasks within a date range (e.g. "between 14th August to 20th August"), convert dates to YYYY-MM-DD format (start_date='2026-08-14', end_date='2026-08-20') and call get_user_tasks with task_type='all'.
6. TEAM NAME MAPPING RULE:
   - Always spell team names as: Bhavin (never Bhabi/Bhabhi), Jemini (starts with J, never Gemini), Chintan, Chetan.
   - If user input contains misheard speech words like "Gemini" or "Bhabi", automatically map them to Jemini and Bhavin.
7. SINGLE / RECENT TASK RESPONSE RULE:
   - When the user asks for "the last task", "recent task", "latest task", or asks which specific task was created last, ONLY output the single 1 most recent task details. NEVER output the entire list of tasks.
8. NEVER output raw JSON. Always summarize tool results in friendly natural language.`;

                const chatConfig = {
                    systemInstruction: systemInstruction
                };
                if (toolsDeclaration && toolsDeclaration.length > 0) {
                    chatConfig.tools = toolsDeclaration;
                }

                const chat = client.chats.create({
                    model: mName,
                    history: geminiHistory,
                    config: chatConfig
                });

                const initialRes = await chat.sendMessage({ message });

                if (initialRes.functionCalls && initialRes.functionCalls.length > 0) {
                    const call = initialRes.functionCalls[0];
                    const toolResult = await executeTool(call.name, call.args, user);

                    const followUpRes = await chat.sendMessage({
                        message: [
                            {
                                functionResponse: {
                                    name: call.name,
                                    response: toolResult
                                }
                            }
                        ]
                    });

                    return { reply: followUpRes.text || JSON.stringify(toolResult) };
                }

                return { reply: initialRes.text || 'Done.' };
            } catch (err) {
                lastError = err;
                console.warn(`Model ${mName} attempt ${attempt} failed:`, err.message || err);
                if (attempt === 1) await new Promise(r => setTimeout(r, 600));
            }
        }
    }

    console.error('All AI Models Failed:', lastError);
    const errMsg = lastError ? (lastError.message || String(lastError)) : '';
    if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('Quota exceeded')) {
        return { reply: `⚠️ High AI traffic / Daily Free limit reached! Please 30 seconds wait karke dobara message bhejin.` };
    }
    return { reply: `AI Response Error: ${errMsg || 'High traffic on AI service. Please try again in a few seconds.'}` };
}

// Groq Whisper Speech-to-Text Transcription Service (0.1s Ultra-fast Hindi/English AI Transcriber)
async function transcribeAudioWithGroq(audioBuffer, filename = 'speech.webm') {
    const groqKey = process.env.GROQ_API_KEY || config.groqApiKey || '';
    if (!groqKey) {
        return await transcribeAudioWithGemini(audioBuffer);
    }

    try {
        let teamContext = 'Bhavin, Jemini, Chintan, Chetan';
        let projectContext = '';
        try {
            const teamRes = await executeTool('get_team_members', {}, { id: 1, role: 'admin' });
            if (teamRes && teamRes.members && Array.isArray(teamRes.members)) {
                teamContext = teamRes.members.map(m => m.name).join(', ');
            }
            const projRes = await executeTool('get_active_projects', { user_id: 1, user_role: 'admin' }, { id: 1, role: 'admin' });
            if (projRes && projRes.projects && Array.isArray(projRes.projects)) {
                projectContext = projRes.projects.map(p => p.name).join(', ');
            }
        } catch (e) {}

        const formData = new FormData();
        const blob = new Blob([audioBuffer], { type: 'audio/webm' });
        formData.append('file', blob, filename);
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('language', 'en');
        formData.append('prompt', `TVA Task Manager dictionary. Team members: ${teamContext}. Projects: ${projectContext}. Always transcribe team names as ${teamContext} and project names as ${projectContext}.`);

        const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqKey}`
            },
            body: formData
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('Groq Whisper API Error:', res.status, errText);
            return await transcribeAudioWithGemini(audioBuffer);
        }

        const data = await res.json();
        return data.text ? data.text.trim() : null;
    } catch (err) {
        console.error('transcribeAudioWithGroq Error:', err);
        return await transcribeAudioWithGemini(audioBuffer);
    }
}

// Fallback: Gemini Audio Transcription
async function transcribeAudioWithGemini(audioBuffer) {
    const geminiKey = process.env.GEMINI_API_KEY || config.geminiApiKey || '';
    if (!geminiKey) return null;
    try {
        const client = new GoogleGenAI({ apiKey: geminiKey });
        const base64Audio = audioBuffer.toString('base64');
        const response = await client.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    inlineData: {
                        mimeType: 'audio/webm',
                        data: base64Audio
                    }
                },
                'Transcribe the spoken audio verbatim in Latin/English letters (Hinglish/English). Output ONLY the exact transcribed text without quotes, notes, or explanations.'
            ]
        });
        const text = response.text ? response.text.trim() : '';
        return text || null;
    } catch (e) {
        console.error('Gemini Audio Transcription Error:', e);
        return null;
    }
}

async function generateProjectTasksFromAI({ name, description, start_date, end_date, users = [] }) {
    const groqKey = process.env.GROQ_API_KEY || config.groqApiKey || '';
    const currentKey = process.env.GEMINI_API_KEY || config.geminiApiKey || '';
    const openrouterKey = process.env.OPENROUTER_API_KEY || config.openrouterApiKey || '';

    const userListStr = (users || []).map(u => `- ${u.name} (ID: ${u.id}, Role: ${u.role}, Department: ${u.department || 'N/A'})`).join('\n');

    const prompt = `You are an expert Project Management AI. Given the project details below, generate a list of 4 to 8 clear, actionable tasks to complete this project.

PROJECT DETAILS:
- Name: ${name}
- Description: ${(description || 'N/A').replace(/<[^>]*>?/gm, '')}
- Start Date: ${start_date || 'N/A'}
- Target End Date: ${end_date || 'N/A'}

AVAILABLE TEAM MEMBERS / ASSIGNEES:
${userListStr || 'No specific team members listed.'}

CRITICAL RULES:
1. Respond ONLY with a valid JSON object. No markdown formatting outside JSON, no backticks, no extra text.
2. Structure the JSON list of tasks exactly like this:
{
  "tasks": [
    {
      "title": "Task title",
      "description": "Short task description",
      "priority": "High",
      "estimated_days": 3,
      "suggested_assignee_id": 1
    }
  ]
}
3. Generate between 4 to 8 clear, actionable tasks.
4. Keep priority strictly as one of: "Low", "Medium", "High", "Critical".
5. Keep estimated_days as a positive integer.
6. Provide clear, realistic, actionable task titles.
7. Set suggested_assignee_id to the best matching user ID from team list, or null if no clear match.`;

    let rawJsonText = null;

    if (openrouterKey && !rawJsonText) {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${openrouterKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "google/gemini-2.5-flash",
                    response_format: { type: "json_object" },
                    messages: [{ role: "user", content: prompt }]
                })
            });
            if (response.ok) {
                const data = await response.json();
                rawJsonText = data.choices?.[0]?.message?.content;
            }
        } catch (e) {
            console.error('generateProjectTasksFromAI OpenRouter Error:', e.message);
        }
    }

    if (currentKey && !rawJsonText) {
        const geminiModels = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];
        for (const gModel of geminiModels) {
            try {
                const client = new GoogleGenAI({ apiKey: currentKey });
                const result = await client.models.generateContent({
                    model: gModel,
                    contents: prompt,
                    config: { responseMimeType: "application/json" }
                });
                rawJsonText = result.text || result.response?.text?.();
                if (rawJsonText) break;
            } catch (e) {
                console.error(`generateProjectTasksFromAI Gemini (${gModel}) Error:`, e.message);
            }
        }
    }

    if (groqKey && !rawJsonText) {
        const groqModels = ['groq/compound', 'openai/gpt-oss-20b'];
        for (const gModel of groqModels) {
            try {
                const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${groqKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: gModel,
                        messages: [{ role: "user", content: prompt }]
                    })
                });
                if (response.ok) {
                    const data = await response.json();
                    rawJsonText = data.choices?.[0]?.message?.content;
                    if (rawJsonText) break;
                }
            } catch (e) {
                console.error(`generateProjectTasksFromAI Groq (${gModel}) Error:`, e.message);
            }
        }
    }

    if (!rawJsonText) {
        throw new Error("Unable to connect to AI service. Please verify GEMINI_API_KEY or GROQ_API_KEY.");
    }

    let cleaned = rawJsonText.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

    return JSON.parse(cleaned);
}

module.exports = { processUserMessage, transcribeAudioWithGroq, generateProjectTasksFromAI };
