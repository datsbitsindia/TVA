
document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) {
        const id = openBtn.dataset.open;
        const m = document.getElementById(id);
        if (m) {
            if (id === 'task-modal') {
                const f = document.getElementById('single-task-form');
                if (f) {
                    f.reset();
                    const inp = document.getElementById('task-id-input');
                    if (inp) inp.value = '';
                    const h = document.getElementById('task-form-heading');
                    if (h) h.textContent = 'Assign employee task';
                }
            }
            if (id === 'employee-modal') {
                const f = document.getElementById('employee-form');
                if (f) {
                    f.reset();
                    const inp = f.elements['id'];
                    if (inp) inp.value = '';
                    const h = document.getElementById('employee-title');
                    if (h) h.textContent = 'Add Team Member';
                    const n = document.getElementById('pwd-note');
                    if (n) n.textContent = 'Required for new members';
                }
            }
            m.classList.add('open');
            m.classList.add('active');
            if (window.initAllCKEditors) setTimeout(window.initAllCKEditors, 100);
        }
    }

    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
        const modal = closeBtn.closest('.modal');
        if (modal) {
            modal.classList.remove('open');
            modal.classList.remove('active');
        }
    }
});

function initMasterAutocomplete() {

    document.querySelectorAll('.autocomplete-master').forEach(input => {
        if (input.dataset.autocompleteInited) return;
        input.dataset.autocompleteInited = 'true';
        const type = input.dataset.type;
        const container = input.parentElement;
        let suggestionsBox = container.querySelector('.autocomplete-suggestions');
        if (!suggestionsBox) {
            suggestionsBox = document.createElement('div');
            suggestionsBox.className = 'autocomplete-suggestions';
            suggestionsBox.style.cssText = 'display:none; position:absolute; top:100%; left:0; right:0; background:#fff; border:1px solid #cbd5e1; border-radius:8px; max-height:180px; overflow-y:auto; z-index:1000; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);';
            container.appendChild(suggestionsBox);
        }

        const fetchAndShow = async () => {
            const val = input.value.trim();
            const endpoint = type === 'department' ? '/api/departments' : '/api/designations';
            try {
                const res = await fetch(`${endpoint}?q=${encodeURIComponent(val)}`);
                const items = await res.json();
                suggestionsBox.innerHTML = '';

                if (items && items.length) {
                    items.forEach(item => {
                        const div = document.createElement('div');
                        div.className = 'suggestion-item';
                        div.style.cssText = 'padding:8px 12px; cursor:pointer; font-size:13px; color:#1e293b; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center;';
                        div.innerHTML = `<span><i class="fa-solid ${type==='department'?'fa-building':'fa-user-tag'}" style="color:#6366f1; margin-right:6px;"></i> <b>${item.name}</b></span> <small style="color:#94a3b8; font-size:11px;">Select</small>`;
                        div.onmousedown = (e) => {
                            e.preventDefault();
                            input.value = item.name;
                            suggestionsBox.style.display = 'none';
                        };
                        suggestionsBox.appendChild(div);
                    });
                } else if (val) {
                    const div = document.createElement('div');
                    div.className = 'suggestion-item new';
                    div.style.cssText = 'padding:8px 12px; cursor:pointer; font-size:13px; color:#4338ca; background:#f5f3ff; font-weight:600;';
                    div.innerHTML = `<i class="fa-solid fa-plus-circle"></i> Add "${val}" as new ${type}`;
                    div.onmousedown = (e) => {
                        e.preventDefault();
                        suggestionsBox.style.display = 'none';
                    };
                    suggestionsBox.appendChild(div);
                } else {
                    suggestionsBox.style.display = 'none';
                    return;
                }
                suggestionsBox.style.display = 'block';
            } catch(e) {}
        };

        input.addEventListener('focus', fetchAndShow);
        input.addEventListener('input', fetchAndShow);
        input.addEventListener('blur', () => {
            setTimeout(() => { suggestionsBox.style.display = 'none'; }, 200);
        });
    });
}
window.addAssigneeChip = function(selectEl, containerId, inputName) {
    const val = selectEl.value;
    if (!val) return;
    const opt = selectEl.options[selectEl.selectedIndex];
    const name = opt.getAttribute('data-name') || opt.dataset.name || opt.text;
    const role = opt.getAttribute('data-role') || opt.dataset.role || '';
    const fieldName = inputName || 'assigned_to';

    const container = document.getElementById(containerId);
    if (!container) return;

    if (container.querySelector(`[data-assignee-id="${val}"], input[value="${val}"]`)) {
        selectEl.value = '';
        return;
    }

    let chipClass = 'assignee-chip';
    if (role === 'Manager') chipClass += ' chip-manager';
    if (role === 'Self') chipClass += ' chip-self';

    const chip = document.createElement('span');
    chip.className = chipClass;
    chip.setAttribute('data-assignee-id', val);
    chip.innerHTML = `
        <i class="fa-solid ${role === 'Manager' ? 'fa-user-tie' : 'fa-user'}"></i>
        <span>${name}</span>
        <input type="hidden" name="${fieldName}" value="${val}">
        <span class="chip-remove-btn" onclick="removeAssigneeChip(this)">&times;</span>
    `;

    container.appendChild(chip);
    selectEl.value = '';
};



window.removeAssigneeChip = function(btnEl) {
    const chip = btnEl.closest('.assignee-chip');
    if (chip) chip.remove();
};

document.addEventListener('DOMContentLoaded', initMasterAutocomplete);



function applyCompactFilter(bar){window.applyCompactFilter(bar);}
window.applyCompactFilter = function(bar) {
    if (!bar) bar = document.querySelector('.compact-filter');

    const queryInput = bar ? bar.querySelector('input[type="search"]') : null;
    let query = (queryInput?.value || '').trim().toLowerCase();
    const selects = bar ? [...bar.querySelectorAll('select')] : [];
    const activeKpi = (bar?.dataset?.activeKpi || window.currentKpiFilter || '').toLowerCase().trim();
    
    let projectFilter = '';
    let statusFilter = '';

    if (query === 'active' || query === 'inactive') {
        statusFilter = query;
        query = '';
    }

    selects.forEach(s => {
        const val = s.value.trim().toLowerCase();
        if (!val || val.startsWith('all ')) return;
        const firstOpt = (s.options[0]?.text || '').toLowerCase();
        if (firstOpt.includes('project') || firstOpt.includes('department')) {
            projectFilter = val;
        } else {
            statusFilter = val;
        }
    });

    let panel = bar ? bar.closest('.ui-panel, .content') || document : document;
    const cards = [...(panel.querySelectorAll('.entity-card, .activity-row') || [])];
    let visible = 0;

    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        const cardStatus = (card.dataset.status || '').toLowerCase();
        const isOverdue = card.dataset.overdue === 'true';
        const isForwarded = card.dataset.forwarded === 'true';
        const cardProject = (card.dataset.project || '').toLowerCase();
        const cardRole = (card.dataset.role || '').toLowerCase();
        const cardAction = (card.dataset.action || '').toLowerCase();

        const matchQuery = !query || text.includes(query);
        let matchStatus = true;

        const checkStatusMatch = (target) => {
            if (!target) return true;
            const targetLower = String(target).toLowerCase().trim();
            const targetClean = targetLower.replaceAll(' ', '-');
            const targetSpace = targetLower.replaceAll('-', ' ');
            const cardStatusLower = cardStatus.toLowerCase().trim();
            const cardStatusClean = cardStatusLower.replaceAll(' ', '-');
            const cardStatusSpace = cardStatusLower.replaceAll('-', ' ');

            if (targetClean === 'overdue' || targetLower === 'overdue') {
                return isOverdue || cardStatusLower === 'overdue';
            }
            if (targetClean.includes('forwarded') || targetLower.includes('forwarded')) {
                return isForwarded;
            }
            if (targetLower === 'pending') {
                return cardStatusLower === 'pending' || cardStatusLower === 'planned';
            }
            if (cardStatusLower) {
                return cardStatusLower === targetLower || 
                       cardStatusClean === targetClean || 
                       cardStatusLower === targetSpace || 
                       cardStatusSpace === targetLower ||
                       cardStatusLower.includes(targetLower) || 
                       cardStatusClean.includes(targetClean) || 
                       text.includes(targetLower) || 
                       text.includes(targetClean);
            }
            return cardRole === targetClean || cardAction === targetClean || text.includes(targetLower);
        };

        if (activeKpi && activeKpi !== 'all') {
            matchStatus = checkStatusMatch(activeKpi);
        } else if (statusFilter) {
            matchStatus = checkStatusMatch(statusFilter);
        }

        let matchProject = true;
        if (projectFilter) {
            if (cardProject) {
                matchProject = cardProject === projectFilter || cardProject.includes(projectFilter);
            } else if (cardAction || cardRole) {
                matchProject = cardAction === projectFilter || cardRole === projectFilter || text.includes(projectFilter);
            } else {
                matchProject = text.includes(projectFilter);
            }
        }

        const activeTabBtn = document.querySelector('.task-tab-btn.active');
        const activeTab = activeTabBtn ? activeTabBtn.getAttribute('data-task-tab') : 'all';
        const cardFilterGroup = card.getAttribute('data-filter-group') || '';

        let matchTab = true;
        if (activeTab === 'assigned-to-me') {
            matchTab = (cardFilterGroup === 'assigned-to-me' || cardFilterGroup === 'self');
        } else if (activeTab === 'assigned-by-me') {
            matchTab = (cardFilterGroup === 'assigned-by-me');
        }

        const isMatch = matchQuery && matchStatus && matchProject && matchTab;
        if (isMatch) {
            card.style.setProperty('display', '', '');
            card.removeAttribute('hidden');
            card.hidden = false;
            visible++;

            const statusPill = card.querySelector('.task-status-pill');
            if (statusPill) {
                if (!activeKpi || activeKpi === 'all') {
                    statusPill.style.setProperty('display', '', '');
                } else {
                    statusPill.style.setProperty('display', 'none', 'important');
                }
            }
        } else {
            card.style.setProperty('display', 'none', 'important');
            card.setAttribute('hidden', 'true');
            card.hidden = true;
        }

    });

    // Dynamic Reordering of Task Cards in DOM
    const listContainer = panel.querySelector('.entity-list');
    if (listContainer && cards.length > 0 && cards[0].classList.contains('task-card')) {
        const priorityRankMap = { 'critical': 1, 'high': 2, 'medium': 3, 'low': 4 };
        const getPriorityRank = (c) => {
            const p = String(c.dataset.priority || '').toLowerCase().trim();
            return priorityRankMap[p] || 5;
        };
        const getCompletedTime = (c) => Number(c.dataset.completedAt || 0);
        const getCreatedTime = (c) => Number(c.dataset.createdAt || 0);

        const isCompletedFilter = activeKpi.includes('completed') || statusFilter.includes('completed');

        cards.sort((a, b) => {
            if (isCompletedFilter) {
                // Completed tab: Sort by completed date & time DESC (latest completed task at top)
                const compA = getCompletedTime(a);
                const compB = getCompletedTime(b);
                if (compA !== compB) return compB - compA;
                return getCreatedTime(b) - getCreatedTime(a);
            } else {
                // Overdue, Pending, In Progress (or general): Priority (Critical -> High -> Medium -> Low)
                const pA = getPriorityRank(a);
                const pB = getPriorityRank(b);
                if (pA !== pB) return pA - pB;
                return getCreatedTime(b) - getCreatedTime(a);
            }
        });

        cards.forEach(card => listContainer.appendChild(card));
    }

    let empty = panel.querySelector('.filter-empty');
    if (!empty) {
        empty = document.createElement('p');
        empty.className = 'empty filter-empty';
        empty.textContent = 'No matching records found.';
        (panel.querySelector('.entity-list, .activity-timeline') || panel).appendChild(empty);
    }
    empty.style.display = (visible === 0) ? 'block' : 'none';
    empty.hidden = (visible !== 0);
};

document.addEventListener('input', event => {
    if (event.target.matches('.compact-filter input')) {
        const bar = event.target.closest('.compact-filter');
        if (bar) window.applyCompactFilter(bar);
    }
});

document.addEventListener('change', event => {
    if (event.target.matches('.compact-filter select')) {
        const bar = event.target.closest('.compact-filter');
        if (bar) window.applyCompactFilter(bar);
    }
});

document.addEventListener('click', event => {
    const btn = event.target.closest('.filter-confirm');
    if (btn) {
        const bar = btn.closest('.compact-filter');
        if (bar) window.applyCompactFilter(bar);
    }
});

document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('.compact-filter input')) {
        event.preventDefault();
        const bar = event.target.closest('.compact-filter');
        if (bar) window.applyCompactFilter(bar);
    }
});

document.querySelectorAll('.edit-employee').forEach(b=>b.onclick=()=>{const d=JSON.parse(b.dataset.employee),f=document.getElementById('employee-form');if(f){Object.keys(d).forEach(k=>{if(f.elements[k])f.elements[k].value=d[k]||''});const t=document.getElementById('employee-title');if(t)t.textContent='Edit Team Member';const n=document.getElementById('pwd-note');if(n)n.textContent='Leave empty to keep existing password';document.getElementById('employee-modal').classList.add('open')}});
document.querySelectorAll('.edit-manager').forEach(b=>b.onclick=()=>{const d=JSON.parse(b.dataset.manager),f=document.getElementById('manager-form');if(f){Object.keys(d).forEach(k=>{if(f.elements[k])f.elements[k].value=d[k]||''});const t=document.getElementById('manager-title');if(t)t.textContent='Edit Manager';const n=document.getElementById('pwd-note');if(n)n.textContent='Leave empty to keep existing password';document.getElementById('manager-modal').classList.add('open')}});


document.querySelectorAll('.entity-card').forEach(card=>{const link=card.querySelector('.entity-title a[href^="/tasks/"]');if(!link)return;card.dataset.cardLink=link.href;card.addEventListener('click',event=>{if(event.target.closest('a,button,input,select,form'))return;location.href=link.href})});

// PWA Service Worker Registration & Persistent Session Handling
let deferredInstallPrompt = null;
if ('serviceWorker' in navigator) {
    const registerSW = () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
            .then(reg => console.log('PWA Service Worker registered:', reg.scope))
            .catch(err => console.error('PWA Service Worker registration failed:', err));
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        registerSW();
    } else {
        window.addEventListener('load', registerSW);
    }
}

// Session keep-alive heartbeat every 4 minutes while app is running
setInterval(() => {
    fetch('/notifications', { method: 'HEAD' }).catch(() => {});
}, 4 * 60 * 1000);

// Capture PWA install prompt
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
});

// Install App button - show guide modal
document.addEventListener('click', (e) => {
    const trigger = e.target.closest('#pwa-install-btn, .pwa-install-trigger');
    if (!trigger) return;
    const modal = document.getElementById('pwa-guide-modal');
    if (modal) modal.classList.add('open');
});

window.closeMobilePwaBanner = function() {
    const banner = document.getElementById('mobile-pwa-banner');
    if (banner) banner.style.display = 'none';
};

// CKEditor Helper Initializer (Bold, Numbered List, Bulleted List only)
window.initCKEditor = function(elementOrSelector) {
    const el = typeof elementOrSelector === 'string' ? document.querySelector(elementOrSelector) : elementOrSelector;
    if (!el || el.dataset.ckeditorInitialized) return Promise.resolve(null);
    el.dataset.ckeditorInitialized = "true";

    if (typeof ClassicEditor === 'undefined') return Promise.resolve(null);

    return ClassicEditor
        .create(el, {
            toolbar: [ 'bold', 'numberedList', 'bulletedList' ]
        })
        .then(editor => {
            editor.model.document.on('change:data', () => {
                el.value = editor.getData();
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });

            try {
                const clipboardPipeline = editor.plugins.get('ClipboardPipeline');
                if (clipboardPipeline) {
                    clipboardPipeline.on('inputTransformation', (evt, data) => {
                        if (data.dataTransfer && data.dataTransfer.getData('text/html')) {
                            let html = data.dataTransfer.getData('text/html');
                            if (html.includes('mso-') || html.includes('<style') || html.includes('<o:')) {
                                html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                                html = html.replace(/\s+style\s*=\s*"[^"]*"/gi, '');
                                html = html.replace(/\s+style\s*=\s*'[^']*'/gi, '');
                                html = html.replace(/\s+class\s*=\s*"[^"]*"/gi, '');
                                html = html.replace(/\s+class\s*=\s*'[^']*'/gi, '');
                                html = html.replace(/<\/?[owm]:[^>]*>/gi, '');
                                html = html.replace(/<!--\[if[\s\S]*?\[endif\]-->/gi, '');
                                try {
                                    data.content = editor.data.parse(html);
                                } catch(e) {}
                            }
                        }
                    }, { priority: 'high' });
                }
            } catch(e) {}

            el._ckeditor = editor;
            return editor;
        })
        .catch(err => {
            console.error('CKEditor initialization error:', err);
            return null;
        });
};

window.initAllCKEditors = function() {
    document.querySelectorAll('textarea.ck-editor-target').forEach(el => {
        window.initCKEditor(el);
    });
};

document.addEventListener('DOMContentLoaded', () => {
    window.initAllCKEditors();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'TEXTAREA') {
        const textarea = e.target;
        const start = textarea.selectionStart;
        const text = textarea.value;
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const line = text.substring(lineStart, start);
        
        const match = line.match(/^(\s*[-•]\s*)/);
        if (match) {
            if (line.trim() === '-' || line.trim() === '•') {
                e.preventDefault();
                textarea.value = text.substring(0, lineStart) + text.substring(start);
                textarea.selectionStart = textarea.selectionEnd = lineStart;
                return;
            }
            e.preventDefault();
            const prefix = '\n' + match[1];
            const before = text.substring(0, start);
            const after = text.substring(start);
            textarea.value = before + prefix + after;
            textarea.selectionStart = textarea.selectionEnd = start + prefix.length;
        }
    }
});

// Universal KPI Card Click Filter & Active Highlight
window.filterByKpi = function(filterVal, event) {
    const bar = document.querySelector('.compact-filter');
    const searchInput = bar ? bar.querySelector('input[type="search"]') : null;
    const selects = bar ? bar.querySelectorAll('select') : [];
    
    // Clear existing highlight
    document.querySelectorAll('.metric-card').forEach(card => {
        card.classList.remove('active-kpi-filter');
    });

    let targetCard = null;
    if (event && event.currentTarget) {
        targetCard = event.currentTarget.closest('.metric-card');
    }

    const valStr = String(filterVal || '').toLowerCase().trim();
    window.currentKpiFilter = valStr;
    if (bar) bar.dataset.activeKpi = valStr;

    if (!valStr || valStr === 'all') {
        if (searchInput) searchInput.value = '';
        selects.forEach(s => s.selectedIndex = 0);
        if (!targetCard) {
            targetCard = document.querySelector('.metric-card[onclick*="all"], .metric-card[title*="all"]');
        }
    } else {
        let matched = false;
        const cleanValStr = valStr.replaceAll(' ', '-');
        const spaceValStr = valStr.replaceAll('-', ' ');
        selects.forEach(s => {
            [...s.options].forEach((opt, idx) => {
                const optText = opt.text.toLowerCase().trim();
                const optVal = opt.value.toLowerCase().trim();
                const optClean = optText.replaceAll(' ', '-');
                if (optText === valStr || optVal === valStr || 
                    optText === cleanValStr || optVal === cleanValStr ||
                    optText === spaceValStr || optVal === spaceValStr ||
                    optClean === cleanValStr ||
                    optText.includes(valStr) || valStr.includes(optText)) {
                    s.selectedIndex = idx;
                    matched = true;
                }
            });
        });

        if (!targetCard) {
            document.querySelectorAll('.metric-card').forEach(card => {
                const onclickAttr = (card.getAttribute('onclick') || '').toLowerCase();
                const hrefAttr = (card.getAttribute('href') || '').toLowerCase();
                const textContent = card.textContent.toLowerCase();
                if (onclickAttr.includes(valStr) || onclickAttr.includes(cleanValStr) || hrefAttr.includes(valStr) || hrefAttr.includes(cleanValStr) || textContent.includes(valStr)) {
                    targetCard = card;
                }
            });
        }
    }

    if (targetCard) {
        targetCard.classList.add('active-kpi-filter');
    }

    if (bar) {
        applyCompactFilter(bar);
    } else {
        const cards = document.querySelectorAll('.entity-card, .activity-row');
        cards.forEach(card => {
            if (!valStr || valStr === 'all') {
                card.style.setProperty('display', '', '');
                card.removeAttribute('hidden');
                card.hidden = false;
            } else {
                const cardStatus = (card.dataset.status || '').toLowerCase();
                const cardText = card.textContent.toLowerCase();
                const cleanVal = valStr.replaceAll(' ', '-');
                const spaceVal = valStr.replaceAll('-', ' ');
                const cardClean = cardStatus.replaceAll(' ', '-');
                const isMatch = cardStatus === valStr || cardStatus === cleanVal || cardStatus === spaceVal || cardClean === cleanVal || cardStatus.includes(cleanVal) || cardStatus.includes(valStr) || cardText.includes(valStr);
                if (isMatch) {
                    card.style.setProperty('display', '', '');
                    card.removeAttribute('hidden');
                    card.hidden = false;
                } else {
                    card.style.setProperty('display', 'none', 'important');
                    card.setAttribute('hidden', 'true');
                    card.hidden = true;
                }
            }
        });
    }
};

// Delegate KPI card click events globally
document.addEventListener('click', event => {
    const card = event.target.closest('.metric-card');
    if (!card) return;
    
    // If card has onclick with filterByKpi, pass event
    const onclickAttr = card.getAttribute('onclick') || '';
    if (onclickAttr.includes('filterByKpi')) return; // already handled inline
    
    // Highlight clicked card
    document.querySelectorAll('.metric-card').forEach(c => c.classList.remove('active-kpi-filter'));
    card.classList.add('active-kpi-filter');
});

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const statusParam = params.get('status');
    if (window.location.pathname === '/tasks' || window.location.pathname === '/tasks/') {
        window.filterByKpi(statusParam || 'Pending');
    } else if (statusParam) {
        window.filterByKpi(statusParam);
    } else {
        const defaultCard = document.querySelector('.metric-card[onclick*="all"], .metric-card[title*="all"]');
        if (defaultCard && document.querySelector('.compact-filter')) {
            defaultCard.classList.add('active-kpi-filter');
        }
    }
});

// Multi-Assignee Chip Selection Helpers
window.removeAssigneeChip = function(btnEl) {
    const chip = btnEl.closest('.assignee-chip');
    if (chip) chip.remove();
};

// Global Custom Confirmation Modal Helper
window.showConfirmDialog = function(options = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('global-confirm-modal');
        if (!modal) {
            resolve(window.confirm ? window.confirm(options.message || 'Are you sure?') : true);
            return;
        }

        const titleEl = document.getElementById('confirm-modal-title');
        const msgEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok-btn');
        const cancelBtn = document.getElementById('confirm-modal-cancel-btn');
        const iconDiv = document.getElementById('confirm-modal-icon');
        const iconI = document.getElementById('confirm-modal-icon-i');

        if (titleEl) titleEl.textContent = options.title || 'Confirm Action';
        if (msgEl) msgEl.textContent = options.message || 'Are you sure you want to proceed?';

        if (okBtn) {
            okBtn.textContent = options.confirmText || (options.danger !== false ? 'Yes, Delete' : 'Confirm');
            if (options.danger !== false) {
                okBtn.className = 'btn btn-confirm-danger';
            } else {
                okBtn.className = 'btn primary';
            }
        }

        if (cancelBtn) {
            cancelBtn.textContent = options.cancelText || 'Cancel';
        }

        if (iconDiv && iconI) {
            if (options.danger !== false) {
                iconDiv.className = 'confirm-modal-icon danger';
                iconI.className = 'fa-solid fa-trash-can';
            } else {
                iconDiv.className = 'confirm-modal-icon warning';
                iconI.className = 'fa-solid fa-triangle-exclamation';
            }
        }

        modal.classList.add('open');
        modal.classList.add('active');

        function cleanup(result) {
            modal.classList.remove('open');
            modal.classList.remove('active');
            if (okBtn) okBtn.removeEventListener('click', onOk);
            if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
            const closeBtn = modal.querySelector('.modal-close');
            if (closeBtn) closeBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        }

        function onOk(e) {
            e.preventDefault();
            cleanup(true);
        }

        function onCancel(e) {
            e.preventDefault();
            cleanup(false);
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                cleanup(false);
            }
        }

        if (okBtn) okBtn.addEventListener('click', onOk);
        if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) closeBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
};

// Global Custom Alert Modal Helper
window.showAlertDialog = function(options = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('global-confirm-modal');
        if (!modal) {
            alert(options.message || 'Alert');
            resolve();
            return;
        }

        const titleEl = document.getElementById('confirm-modal-title');
        const msgEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok-btn');
        const cancelBtn = document.getElementById('confirm-modal-cancel-btn');
        const iconDiv = document.getElementById('confirm-modal-icon');
        const iconI = document.getElementById('confirm-modal-icon-i');

        if (titleEl) titleEl.textContent = options.title || 'Validation Error';
        if (msgEl) msgEl.textContent = options.message || 'An error occurred.';

        if (okBtn) {
            okBtn.textContent = options.confirmText || 'OK';
            okBtn.className = 'btn primary';
        }

        if (cancelBtn) {
            cancelBtn.style.display = 'none';
        }

        if (iconDiv && iconI) {
            iconDiv.className = 'confirm-modal-icon warning';
            iconI.className = 'fa-solid fa-triangle-exclamation';
        }

        modal.classList.add('open');
        modal.classList.add('active');

        function cleanup() {
            modal.classList.remove('open');
            modal.classList.remove('active');
            if (cancelBtn) cancelBtn.style.display = '';
            if (okBtn) okBtn.removeEventListener('click', onOk);
            const closeBtn = modal.querySelector('.modal-close');
            if (closeBtn) closeBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve();
        }

        function onOk(e) {
            e.preventDefault();
            cleanup();
        }

        function onCancel(e) {
            e.preventDefault();
            cleanup();
        }

        function onKey(e) {
            if (e.key === 'Escape' || e.key === 'Enter') {
                cleanup();
            }
        }

        if (okBtn) okBtn.addEventListener('click', onOk);
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) closeBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
};


// Global Form Submit Interceptor to show custom in-app confirmation modal instead of browser alert/confirm
document.addEventListener('submit', async function(e) {
    const form = e.target;
    if (form.dataset.confirmed === 'true') return;

    let confirmMsg = form.dataset.confirm;
    if (!confirmMsg && form.getAttribute('onsubmit')) {
        const match = form.getAttribute('onsubmit').match(/confirm\(['"](.*?)['"]\)/);
        if (match && match[1]) {
            confirmMsg = match[1];
        }
    }

    if (confirmMsg) {
        e.preventDefault();
        e.stopPropagation();

        const isDelete = form.action.includes('delete') || form.classList.contains('delete-form') || confirmMsg.toLowerCase().includes('delete');

        const confirmed = await window.showConfirmDialog({
            title: isDelete ? 'Confirm Action' : 'Please Confirm',
            message: confirmMsg,
            confirmText: isDelete ? 'Yes, Delete' : 'Confirm',
            danger: isDelete
        });

        if (confirmed) {
            form.dataset.confirmed = 'true';
            if (form.requestSubmit) {
                form.requestSubmit();
            } else {
                form.submit();
            }
        }
    }
}, true);

// Real-Time Background Live Sync Engine
(function initLiveSync() {
    let lastTaskId = 0;
    let lastNotifId = 0;
    let activeTaskId = 0;
    let lastCommentId = 0;
    let isInitialSync = true;

    const taskMatch = window.location.pathname.match(/\/tasks\/(\d+)/);
    if (taskMatch && taskMatch[1]) {
        activeTaskId = Number(taskMatch[1]);
        const commentBubbles = document.querySelectorAll('.chat-bubble[data-comment-id]');
        commentBubbles.forEach(b => {
            const cid = Number(b.dataset.commentId);
            if (cid > lastCommentId) lastCommentId = cid;
        });
    }

    // Track highest existing task ID on the current page
    const existingCards = document.querySelectorAll('.entity-card.task-card');
    existingCards.forEach(card => {
        const link = card.querySelector('a[href^="/tasks/"]');
        if (link) {
            const match = link.href.match(/\/tasks\/(\d+)/);
            if (match && match[1]) {
                const tid = Number(match[1]);
                if (tid > lastTaskId) lastTaskId = tid;
            }
        }
    });

    async function pollUpdates() {
        try {
            const res = await fetch(`/api/live-check?last_task_id=${lastTaskId}&last_notif_id=${lastNotifId}&active_task_id=${activeTaskId}&last_comment_id=${lastCommentId}`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (!res.ok) return;
            const data = await res.json();
            if (!data.success) return;

            // ─── Initial baseline sync: set IDs and return, never mutate DOM ───
            if (isInitialSync) {
                isInitialSync = false;
                lastTaskId = data.maxTaskId || lastTaskId;
                lastNotifId = data.maxNotifId || lastNotifId;
                return;
            }

            // 1. Update Notification Bell Badge (Desktop & Mobile)
            const badges = document.querySelectorAll('a[href="/notifications"] .badge');
            badges.forEach(badge => {
                if (data.unreadCount > 0) {
                    badge.textContent = data.unreadCount;
                    badge.style.display = 'inline-block';
                } else {
                    badge.style.display = 'none';
                    badge.textContent = '';
                }
            });

            // 2. Task Detail Status Live Update
            if (data.activeTaskData) {
                const overallChip = document.querySelector('.task-info-grid .status-chip');
                if (overallChip && data.activeTaskData.status) {
                    const newStatusStr = data.activeTaskData.status;
                    if (overallChip.textContent.trim() !== newStatusStr) {
                        overallChip.textContent = newStatusStr;
                        overallChip.className = 'status-chip ' + newStatusStr.toLowerCase().replaceAll(' ', '-');
                    }
                }

                if (data.activeTaskData.assignees && data.activeTaskData.assignees.length) {
                    data.activeTaskData.assignees.forEach(a => {
                        // Only update OTHER users' status chips, skip current user's own chip
                        if (Number(a.user_id) === Number(window.currentUserId || 0)) return;
                        const assigneeChip = document.querySelector(`.assignee-chip-user-${a.user_id}`);
                        if (assigneeChip && a.status) {
                            if (assigneeChip.textContent.trim() !== a.status) {
                                assigneeChip.textContent = a.status;
                                assigneeChip.className = `status-chip assignee-chip-user-${a.user_id} ` + a.status.toLowerCase().replaceAll(' ', '-');
                            }
                        }
                    });
                }
            }

            // 3. Task Detail Discussion Comments Live Append
            if (data.newComments && data.newComments.length > 0) {
                const chatBox = document.getElementById('chat-messages-box');
                if (chatBox) {
                    data.newComments.forEach(c => {
                        if (chatBox.querySelector(`[data-comment-id="${c.id}"]`)) return;

                        const isOutgoing = Number(c.user_id) === Number(window.currentUserId || 0);
                        const bubble = document.createElement('div');
                        bubble.className = `chat-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;
                        bubble.dataset.commentId = c.id;

                        let dateStr = String(c.created_at || '').trim();
                        if (dateStr && !dateStr.includes('T') && dateStr.includes(' ')) dateStr = dateStr.replace(' ', 'T');
                        const d = new Date(dateStr);
                        const timeStr = isNaN(d.getTime()) ? c.created_at : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

                        bubble.innerHTML = `
                            ${!isOutgoing ? `<span class="sender-name">${c.name}</span>` : ''}
                            <p class="message-text">${c.message}</p>
                            <div class="message-meta">
                                <time>${timeStr}</time>
                                ${isOutgoing ? '<i class="fa-solid fa-check-double read-receipt"></i>' : ''}
                            </div>
                        `;

                        chatBox.appendChild(bubble);
                        if (c.id > lastCommentId) lastCommentId = c.id;
                    });

                    const emptyChat = chatBox.querySelector('.empty-chat');
                    if (emptyChat) emptyChat.style.display = 'none';

                    const badgeCount = document.querySelector('.whatsapp-chat-panel .badge-count');
                    if (badgeCount) {
                        const total = chatBox.querySelectorAll('.chat-bubble').length;
                        badgeCount.textContent = `${total} updates`;
                    }

                    chatBox.scrollTop = chatBox.scrollHeight;
                }
            }

            // ─── Removed old isInitialSync block from here (moved to top) ───

            // 4. Process New Notifications (Show Toast Alert)
            if (data.newNotifications && data.newNotifications.length > 0) {
                data.newNotifications.forEach(notif => {
                    if (window.showToast) {
                        window.showToast(`🔔 ${notif.message}`, 'info', 6000);
                    }
                });
                lastNotifId = data.maxNotifId;
            }

            // 5. Process New Tasks (Auto-Prepend Task Card if on /tasks)
            if (data.newTasks && data.newTasks.length > 0) {
                const listContainer = document.querySelector('.entity-list');
                if (listContainer) {
                    data.newTasks.slice().reverse().forEach(t => {
                        if (document.querySelector(`.task-card-item-${t.id}`)) return;

                        const article = document.createElement('article');
                        article.className = `entity-card task-card task-card-item-${t.id} ${t.is_overdue ? 'overdue-card' : ''} ${t.is_routine ? 'routine-task-card' : ''}`;
                        article.dataset.status = String(t.status || 'pending').toLowerCase().replaceAll(' ', '-');
                        article.dataset.overdue = t.is_overdue ? 'true' : 'false';
                        article.dataset.forwarded = t.is_forwarded ? 'true' : 'false';
                        article.dataset.project = (t.project_name || '').toLowerCase();
                        article.dataset.filterGroup = t.filterGroup;
                        article.dataset.priority = String(t.priority || 'medium').toLowerCase();
                        article.dataset.completedAt = t.completed_at ? new Date(t.completed_at).getTime() : 0;
                        article.dataset.createdAt = t.created_at ? new Date(t.created_at).getTime() : 0;
                        article.dataset.id = t.id;
                        article.dataset.cardLink = `/tasks/${t.id}`;
                        article.style.animation = 'highlightTaskPulse 2.5s ease';
                        article.style.cursor = 'pointer';

                        const formatDateStr = (dStr) => {
                            if (!dStr) return '';
                            const d = new Date(dStr);
                            if (isNaN(d.getTime())) return dStr;
                            return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                        };

                        article.innerHTML = `
                            <div class="entity-title">
                                <div class="task-title-row" style="display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; overflow: hidden; width: 100%;">
                                    <a href="/tasks/${t.id}" style="font-weight: 800; font-size: 14px; color: #0f172a; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 40px;">
                                        #${t.task_number || t.id} ${t.title}
                                    </a>
                                    ${t.is_routine ? '<span class="routine-badge" style="flex:0 0 auto; margin:0!important;"><i class="fa-solid fa-repeat"></i> Routine</span>' : ''}
                                    ${t.isPureSelf ? `
                                        <span class="status-chip self-task" style="background:#e0e7ff;color:#4338ca;border:1px solid #c7d2fe;padding:2px 6px;font-size:9px;font-weight:700;display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;margin:0!important;">
                                            <i class="fa-solid fa-user-check"></i> Self Task
                                        </span>
                                    ` : ''}
                                    <span class="priority-pill ${(t.priority || 'medium').toLowerCase()}" style="font-weight:700; font-size:9px; padding:2px 6px; border-radius:99px; flex:0 0 auto; margin:0!important;">
                                        <i class="fa-solid fa-flag"></i> ${t.priority || 'Medium'}
                                    </span>
                                    ${t.is_forwarded ? `
                                        <span class="status-chip forwarded" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;padding:2px 6px;font-size:9px;font-weight:700;flex:0 0 auto;margin:0!important;">
                                            <i class="fa-solid fa-share"></i> Forwarded
                                        </span>
                                    ` : ''}
                                    <span class="status-chip task-status-pill ${t.is_overdue ? 'overdue' : String(t.status || 'Pending').toLowerCase().replaceAll(' ', '-')}" style="flex:0 0 auto; font-size:9px; padding:2px 6px; margin:0!important;">
                                        ${t.is_overdue ? 'Overdue' : t.status}
                                    </span>
                                    ${(t.status === 'Completed' || t.status === '2') ? (
                                        t.is_verified ? `
                                            <span class="status-chip verified-chip" style="background:#dcfce7; color:#15803d; border:1px solid #bbf7d0; padding:2px 6px; font-size:9px; font-weight:700; flex:0 0 auto; margin:0!important;" title="Verified by ${t.verifier_name || 'Manager'}">
                                                <i class="fa-solid fa-certificate"></i> Verified
                                            </span>
                                        ` : `
                                            <span class="status-chip awaiting-chip" style="background:#fef9c3; color:#b45309; border:1px solid #fde68a; padding:2px 6px; font-size:9px; font-weight:700; flex:0 0 auto; margin:0!important;" title="Awaiting Manager Verification">
                                                <i class="fa-solid fa-triangle-exclamation"></i> Awaiting Verification
                                            </span>
                                        `
                                    ) : ''}
                                </div>
                                <small style="display: block; color: #3b68b7; font-weight: 600; margin-top: 2px; font-size: 11px;">
                                    <i class="fa-solid fa-folder-open" style="margin-right: 3px;"></i>${t.project_name || 'No project'}
                                </small>
                            </div>
                            <div class="entity-meta">
                                <small>Assigned By</small>
                                <b>${t.creator_name || 'You'}</b>
                            </div>
                            <div class="entity-meta">
                                <small>Assigned To</small>
                                <b>${t.assigned_name || 'You'}</b>
                            </div>
                            <div class="entity-meta">
                                <small>Assigned on</small>
                                <b>${formatDateStr(t.created_at)}</b>
                            </div>
                            <div class="entity-meta" style="text-align: right;">
                                <small>Due date</small>
                                <b>${formatDateStr(t.due_date)}</b>
                            </div>
                        `;

                        article.addEventListener('click', event => {
                            if (event.target.closest('a,button,input,select,form')) return;
                            location.href = `/tasks/${t.id}`;
                        });

                        listContainer.prepend(article);
                    });

                    const emptyMsg = listContainer.querySelector('.filter-empty');
                    if (emptyMsg) emptyMsg.style.display = 'none';

                    const bar = document.querySelector('.compact-filter');
                    if (bar && window.applyCompactFilter) {
                        window.applyCompactFilter(bar);
                    }
                }

                lastTaskId = data.maxTaskId;
            }
        } catch (err) {
            // Background sync error silent catch
        }
    }

    setInterval(pollUpdates, 3000);
    setTimeout(pollUpdates, 1000);
})();

// Validate Manager selection before submitting Create Project form
document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form && (form.id === 'create-project-form' || (form.getAttribute('action') === '/projects' && form.getAttribute('method')?.toLowerCase() === 'post'))) {
        const isEdit = form.querySelector('input[name="id"]');
        if (isEdit) return;

        const managerInputs = form.querySelectorAll('input[name="manager_id"]');
        const hasManager = Array.from(managerInputs).some(inp => Boolean(inp.value && inp.value.trim()));

        if (!hasManager) {
            e.preventDefault();
            e.stopPropagation();
            if (window.showAlertDialog) {
                window.showAlertDialog({
                    title: 'Select Manager',
                    message: '⚠️ Please select at least one Manager before assigning the project.'
                });
            } else {
                alert('⚠️ Please select at least one Manager before assigning the project.');
            }
            return false;
        }
    }
}, true);

document.addEventListener('click', function(e) {
    const btn = e.target.closest('#btn-assign-project, form[action="/projects"] button.primary');
    if (btn) {
        const form = btn.closest('form');
        if (form && !form.querySelector('input[name="id"]')) {
            const managerInputs = form.querySelectorAll('input[name="manager_id"]');
            const hasManager = Array.from(managerInputs).some(inp => Boolean(inp.value && inp.value.trim()));
            if (!hasManager) {
                e.preventDefault();
                e.stopPropagation();
                if (window.showAlertDialog) {
                    window.showAlertDialog({
                        title: 'Select Manager',
                        message: '⚠️ Please select at least one Manager before assigning the project.'
                    });
                } else {
                    alert('⚠️ Please select at least one Manager before assigning the project.');
                }
                return false;
            }
        }
    }
}, true);
// Global Floating Toast System
window.showToast = function(titleOrMessage, subtitleOrType, duration = 3500) {
    let existing = document.querySelector('.success-toast, .app-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'success-toast';

    let title = 'Update successful';
    let subtitle = titleOrMessage || '';
    let icon = 'fa-circle-check';

    if (typeof subtitleOrType === 'string' && subtitleOrType !== 'info' && subtitleOrType !== 'success' && subtitleOrType !== 'error') {
        subtitle = subtitleOrType;
        title = titleOrMessage;
    } else if (titleOrMessage) {
        subtitle = titleOrMessage;
    }

    if (subtitleOrType === 'error') {
        icon = 'fa-circle-xmark';
        toast.style.borderColor = '#fca5a5';
        toast.style.background = '#fef2f2';
        toast.style.color = '#991b1b';
    }

    toast.innerHTML = `
        <i class="fa-solid ${icon}"></i>
        <span>
            <b>${title}</b>
            <small>${subtitle}</small>
        </span>
        <button type="button" class="toast-close-btn" onclick="this.parentElement.remove()">&times;</button>
    `;

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 300);
    }, duration);
};

// Auto-dismiss any server-rendered .success-toast after 3.5 seconds
document.addEventListener('DOMContentLoaded', () => {
    const serverToasts = document.querySelectorAll('.success-toast');
    serverToasts.forEach(toast => {
        if (!toast.querySelector('.toast-close-btn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toast-close-btn';
            btn.innerHTML = '&times;';
            btn.onclick = () => toast.remove();
            toast.appendChild(btn);
        }
        setTimeout(() => {
            toast.classList.add('hide');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    });
});
