document.addEventListener('DOMContentLoaded', () => {
    const toggleBtn = document.getElementById('ai-chat-toggle');
    const closeBtn = document.getElementById('ai-chat-close');
    const clearBtn = document.getElementById('ai-chat-clear');
    const drawer = document.getElementById('ai-chat-drawer');
    const chatForm = document.getElementById('ai-chat-form');
    const chatInput = document.getElementById('ai-chat-input');
    const chatBody = document.getElementById('ai-chat-body');
    const micBtn = document.getElementById('ai-mic-btn');

    if (!toggleBtn || !drawer) return;

    const defaultGreeting = `👋 Namaste! Main aapka AI Task Assistant hoon. Main aapke tasks search, create, ya summarize kar sakta hoon. Bolie kya madad karun?`;

    // --- Text to Speech (TTS) ---
    function speakText(rawText) {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel(); // Stop any ongoing speech

        const cleanText = rawText
            .replace(/<[^>]*>/g, '')
            .replace(/[\*\_`#]/g, '')
            .replace(/https?:\/\/\S+/g, 'link')
            .trim();

        if (!cleanText) return;

        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.lang = 'en-IN'; // Indian accent English / Hinglish
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        window.speechSynthesis.speak(utterance);
    }

    function getPriorityBadge(priority) {
        const map = {
            'critical': { color: '#dc2626' },
            'high':     { color: '#ea580c' },
            'medium':   { color: '#ca8a04' },
            'low':      { color: '#16a34a' }
        };
        const k = (priority || '').toLowerCase();
        const s = map[k] || { color: '#64748b' };
        return `<span style="color:${s.color};font-weight:700;">${priority}</span>`;
    }

    function renderMarkdownTable(tableText) {
        const lines = tableText.trim().split('\n').filter(l => l.trim());
        if (lines.length < 3) return null;

        let headers = lines[0].split('|').map(h => h.trim()).filter(Boolean);
        let rows = lines.slice(2).map(l => l.split('|').map(c => c.trim()).filter(Boolean));

        if (headers.length === 0 || rows.length === 0) return null;

        // Remove Description column
        const descIdx = headers.findIndex(h => /description/i.test(h));
        if (descIdx !== -1) {
            headers = headers.filter((_, i) => i !== descIdx);
            rows = rows.map(r => r.filter((_, i) => i !== descIdx));
        }

        // Move Project column to index 2 (3rd position, after ID and Title)
        const projIdx = headers.findIndex(h => /project/i.test(h));
        if (projIdx !== -1 && projIdx !== 2) {
            const moveCol = (arr, from, to) => {
                const a = [...arr];
                const [item] = a.splice(from, 1);
                a.splice(to, 0, item);
                return a;
            };
            headers = moveCol(headers, projIdx, Math.min(2, headers.length - 1));
            rows = rows.map(r => moveCol(r, projIdx, Math.min(2, r.length - 1)));
        }

        const isPriorityCol = (h) => /priority/i.test(h);

        let html = `<div style="overflow-x:auto;margin:8px 0;border-radius:8px;border:1px solid #e2e8f0;font-size:12.5px;">`;
        html += `<table style="width:100%;border-collapse:collapse;min-width:360px;">`;

        // Header row
        html += `<thead><tr style="background:#f1f5f9;border-bottom:2px solid #cbd5e1;">`;
        headers.forEach(h => {
            html += `<th style="padding:8px 12px;text-align:left;font-weight:600;color:#374151;white-space:nowrap;">${h}</th>`;
        });
        html += `</tr></thead><tbody>`;

        // Data rows
        rows.forEach((row, i) => {
            html += `<tr style="background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'};border-bottom:1px solid #e2e8f0;">`;
            headers.forEach((h, j) => {
                const cell = row[j] || '';
                if (isPriorityCol(h)) {
                    html += `<td style="padding:7px 12px;">${getPriorityBadge(cell)}</td>`;
                } else {
                    html += `<td style="padding:7px 12px;color:#1e293b;">${cell}</td>`;
                }
            });
            html += `</tr>`;
        });

        html += `</tbody></table></div>`;
        return html;
    }


    function formatMessageHtml(text) {
        if (!text) return '';

        // Extract and render markdown tables before other processing
        let processed = String(text);

        // Find all markdown tables (| ... | patterns spanning multiple lines)
        processed = processed.replace(/((?:\|[^\n]+\|\n?)+)/g, (match) => {
            const rendered = renderMarkdownTable(match);
            return rendered ? rendered : match;
        });

        return processed
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            // Undo escaping in rendered HTML tags (our injected HTML from renderMarkdownTable)
            .replace(/&lt;(\/?(div|span|table|thead|tbody|tr|th|td|strong|em|code|br)[^&]*?)&gt;/gi, '<$1>')
            .replace(/&amp;/g, '&')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code style="background:#e2e8f0;padding:2px 5px;border-radius:4px;font-size:12px;color:#0f172a;">$1</code>')
            .replace(/\n/g, '<br>');
    }




    function appendMessage(text, sender) {
        const msg = document.createElement('div');
        msg.className = `ai-msg ${sender}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = formatMessageHtml(text);
        msg.appendChild(contentDiv);

        if (sender === 'bot' && text !== 'Thinking...') {
            const footerDiv = document.createElement('div');
            footerDiv.className = 'ai-msg-footer';
            
            const speakBtn = document.createElement('button');
            speakBtn.type = 'button';
            speakBtn.className = 'ai-speak-btn';
            speakBtn.title = 'Listen to AI Voice';
            speakBtn.innerHTML = `<i class="fa-solid fa-volume-high"></i> Listen`;
            speakBtn.onclick = () => speakText(text);

            footerDiv.appendChild(speakBtn);
            msg.appendChild(footerDiv);
        }

        chatBody.appendChild(msg);
        chatBody.scrollTop = chatBody.scrollHeight;
        return msg;
    }

    // --- REAL-TIME LIVE VOICE TYPING (SpeechRecognition + MediaRecorder Fallback) ---
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let liveRecognition = null;
    let isLiveListening = false;

    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let speechBaseText = '';
    let vadAudioContext = null;
    let vadAnimId = null;

    // Detect if running inside Windows Desktop app wrapper (.exe / WebView2 / Electron / Standalone)
    const isDesktopApp = !!(
        (window.chrome && window.chrome.webview) ||
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone ||
        navigator.userAgent.includes('Electron') ||
        navigator.userAgent.includes('TVA-TASK') ||
        window.location.protocol === 'file:'
    );

    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // Smart Phonetic Auto-Corrector for Indian Names & TVA Vocabulary
    function cleanAndCorrectSpeechText(rawText) {
        if (!rawText) return '';
        let cleaned = String(rawText);

        // Deduplicate immediately repeated words / tokens (e.g. "create create" -> "create")
        cleaned = cleaned.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');

        const corrections = [
            [/\b(candy|can u|can you)\s+show\s+(me\s+)?folder\s+task\b/gi, 'show me all tasks'],
            [/\b(advait|adwait|admit|advit|advik|avaidh|ayurvet|invite|ad\s*wait|ad\s*vait)\s*[\.,]?\s*(shakti|sakti|chitti)?\b/gi, 'AdwaitShakti'],
            [/\branveer\s+chitti\b/gi, 'AdwaitShakti'],
            [/\badwaitshaktisakte\s+hain\b/gi, 'AdwaitShakti'],
            [/\b(sakti|shakti)\b/gi, 'AdwaitShakti'],
            [/\b(hi|bye|hai|hie)\s+priority\b/gi, 'High priority'],
            [/\b(very\s+)?hi\s+priority\b/gi, 'High priority'],
            [/\btune\s+(a\s+)?new\s+task\b/gi, 'create a new task'],
            [/\bdates\s+tomorrow\b/gi, 'due tomorrow'],
            [/\borganist\b/gi, 'August'],
            [/\borgust\b/gi, 'August'],
            [/\bovers\s+to\b/gi, 'August to'],
            [/\bovers\b/gi, 'August'],
            [/\b(gemini|jimini|jamini|gemeny|gemny)\b/gi, 'Jemini'],
            [/\b(bhabi|bhabhi|bhabin|bhavan|bhavik)\b/gi, 'Bhavin'],
            [/\b(chintam|chin tan|chin-tan|chintain|chintun)\b/gi, 'Chintan'],
            [/\b(chetan|cheetan|chatan)\b/gi, 'Chetan'],
            [/\bback up\b/gi, 'Backup'],
            [/\bto do\b/gi, 'To Do'],
            [/\bin progress\b/gi, 'In Progress']
        ];

        corrections.forEach(([pattern, replacement]) => {
            cleaned = cleaned.replace(pattern, replacement);
        });

        return cleaned;
    }

    // Extracts clean transcript from SpeechRecognition results, eliminating mobile/Android cumulative word duplication
    function extractTranscriptFromResults(results) {
        if (!results || results.length === 0) return '';

        let combined = '';
        for (let i = 0; i < results.length; i++) {
            const item = results[i][0];
            if (!item || !item.transcript) continue;
            const current = item.transcript.trim();
            if (!current) continue;

            const currentLower = current.toLowerCase();
            const combinedLower = combined.toLowerCase();

            // On Android / mobile, SpeechRecognition returns cumulative phrases in new indices
            if (combined && (currentLower.startsWith(combinedLower) || currentLower.includes(combinedLower))) {
                combined = current; // Keep latest longer revised phrase
            } else if (combined && combinedLower.startsWith(currentLower)) {
                continue;
            } else {
                combined = combined ? (combined + ' ' + current) : current;
            }
        }

        return combined.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1').trim();
    }

    // Keep speechBaseText synced if user manually edits text
    if (chatInput) {
        chatInput.addEventListener('input', () => {
            if (!isLiveListening && !isRecording) {
                speechBaseText = chatInput.value ? chatInput.value.trim() : '';
            }
        });
    }

    // 1. Primary: Real-Time Live Word-by-Word Typing in Textarea (For standard browsers)
    if (SpeechRecognition && !isDesktopApp) {
        try {
            liveRecognition = new SpeechRecognition();
            liveRecognition.continuous = !isMobileDevice;
            liveRecognition.interimResults = true;
            liveRecognition.lang = 'en-IN'; // Indian English / Hinglish

            liveRecognition.onstart = () => {
                isLiveListening = true;
                if (micBtn) {
                    micBtn.classList.add('listening');
                    micBtn.title = "Listening... Click mic when done speaking 🎙️";
                }
                chatInput.placeholder = "🔴 Listening... Speak now to type in real-time 🎙️";
            };

            liveRecognition.onresult = (event) => {
                const transcript = extractTranscriptFromResults(event.results);
                if (transcript) {
                    const cleaned = cleanAndCorrectSpeechText(transcript);
                    // Prepend existing text so previously spoken / typed text is never erased!
                    chatInput.value = speechBaseText ? (speechBaseText + ' ' + cleaned) : cleaned;
                    adjustInputHeight();
                }
            };

            liveRecognition.onerror = (event) => {
                console.warn('SpeechRecognition live error:', event.error);
                if (event.error !== 'no-speech' && event.error !== 'aborted') {
                    stopLiveListening();
                    liveRecognition = null;
                    startMediaRecorderFallback();
                }
            };

            liveRecognition.onend = () => {
                if (isLiveListening) {
                    // Mobile auto-restart after pause: preserve all accumulated text into speechBaseText
                    speechBaseText = chatInput.value ? chatInput.value.trim() : '';
                    try {
                        liveRecognition.start();
                        return;
                    } catch (e) {}
                }
                stopLiveListening();
            };

            function stopLiveListening() {
                isLiveListening = false;
                speechBaseText = chatInput.value ? chatInput.value.trim() : '';
                if (micBtn) {
                    micBtn.classList.remove('listening');
                    micBtn.title = "Voice Input (Speech-to-Text)";
                }
                if (chatInput) chatInput.placeholder = "Type or speak a message...";
            }
        } catch (e) {
            console.warn("Live SpeechRecognition setup error:", e);
            liveRecognition = null;
        }
    }

    // 2. High-Accuracy Audio Capture + Groq Whisper AI Transcription (for Desktop .exe & SpeechRecognition Fallback)
    async function startMediaRecorderFallback() {
        const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (!isSecure) {
                alert(
                    '🎙️ Microphone Access Blocked:\n\n' +
                    'You are accessing over plain HTTP (' + location.origin + '). Chrome/Edge disables speech API on HTTP.\n\n' +
                    'Fix: Open chrome://flags/#unsafely-treat-insecure-origin-as-secure, add "' + location.origin + '", set to Enabled, and Relaunch browser.'
                );
            } else {
                alert('🎙️ Microphone access is not supported in this browser. Please try Chrome or Edge.');
            }
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            speechBaseText = chatInput.value ? chatInput.value.trim() : '';

            let mimeType = 'audio/webm';
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                mimeType = 'audio/webm;codecs=opus';
            } else if (MediaRecorder.isTypeSupported('audio/webm')) {
                mimeType = 'audio/webm';
            } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
                mimeType = 'audio/mp4';
            } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
                mimeType = 'audio/ogg';
            } else {
                mimeType = '';
            }

            const options = mimeType ? { mimeType } : {};
            mediaRecorder = new MediaRecorder(stream, options);

            // Voice Activity Detection (Auto-detect speech & auto-stop on silence)
            let silenceStart = null;
            let hasSpoken = false;
            let recordingStartTime = Date.now();

            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) {
                    vadAudioContext = new AudioContextClass();
                    const source = vadAudioContext.createMediaStreamSource(stream);
                    const analyser = vadAudioContext.createAnalyser();
                    analyser.fftSize = 256;
                    source.connect(analyser);

                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    function checkAudioLevel() {
                        if (!isRecording) return;
                        analyser.getByteFrequencyData(dataArray);
                        let sum = 0;
                        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                        const avg = sum / dataArray.length;

                        if (avg > 12) {
                            hasSpoken = true;
                            silenceStart = null;
                        } else {
                            if (hasSpoken) {
                                if (!silenceStart) silenceStart = Date.now();
                                else if (Date.now() - silenceStart > 1800) {
                                    // 1.8 seconds silence after speaking -> auto-stop and transcribe!
                                    stopAndTranscribe();
                                    return;
                                }
                            } else if (Date.now() - recordingStartTime > 10000) {
                                // 10 seconds without any speech -> auto-cancel
                                stopAndTranscribe();
                                return;
                            }
                        }
                        vadAnimId = requestAnimationFrame(checkAudioLevel);
                    }
                    vadAnimId = requestAnimationFrame(checkAudioLevel);
                }
            } catch (e) {
                console.warn('VAD AudioContext init warning:', e);
            }

            mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) audioChunks.push(event.data);
            };

            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(track => track.stop());
                if (vadAudioContext && vadAudioContext.state !== 'closed') {
                    try { vadAudioContext.close(); } catch (e) {}
                }
                if (vadAnimId) cancelAnimationFrame(vadAnimId);
                stopRecordingUI();

                if (audioChunks.length === 0) return;
                const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                if (audioBlob.size < 100) return;

                chatInput.placeholder = "Converting voice to text with AI... ⏳";
                chatInput.disabled = true;

                try {
                    const formData = new FormData();
                    const ext = (mediaRecorder.mimeType && mediaRecorder.mimeType.includes('mp4')) ? 'mp4' : 'webm';
                    formData.append('audio', audioBlob, `voice.${ext}`);

                    const response = await fetch('/api/chat/transcribe', {
                        method: 'POST',
                        body: formData
                    });

                    const data = await response.json();
                    chatInput.disabled = false;
                    chatInput.placeholder = "Type or speak a message...";

                    if (data.success && data.transcription) {
                        const cleaned = cleanAndCorrectSpeechText(data.transcription);
                        chatInput.value = speechBaseText ? (speechBaseText + ' ' + cleaned) : cleaned;
                        speechBaseText = chatInput.value.trim();
                        adjustInputHeight();
                        chatInput.focus();
                    } else if (hasSpoken) {
                        alert('🎙️ ' + (data.error || 'Could not convert voice to text. Please try speaking again.'));
                    }
                } catch (err) {
                    chatInput.disabled = false;
                    chatInput.placeholder = "Type or speak a message...";
                    console.error("Voice transcription error:", err);
                }
            };

            mediaRecorder.start(200);
            isRecording = true;
            if (micBtn) {
                micBtn.classList.add('listening');
                micBtn.title = "Listening... Click mic or pause to convert 🎙️";
            }
            chatInput.placeholder = "🔴 Listening... Speak now (auto-stops when you pause) 🎙️";

        } catch (err) {
            console.error('Mic access error:', err);
            stopRecordingUI();
            alert('🎙️ Microphone Permission Required:\n\nPlease allow Microphone access in Windows/browser settings.');
        }
    }

    function stopAndTranscribe() {
        if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
            try { mediaRecorder.stop(); } catch (e) {}
        }
        isRecording = false;
    }

    function stopRecordingUI() {
        isRecording = false;
        if (vadAnimId) cancelAnimationFrame(vadAnimId);
        if (micBtn) {
            micBtn.classList.remove('listening');
            micBtn.title = "Voice Input (Speech-to-Text)";
        }
        if (chatInput) {
            chatInput.placeholder = "Type or speak a message...";
        }
    }

    // Toggle Microphone Click Event
    if (micBtn) {
        micBtn.addEventListener('click', (e) => {
            e.preventDefault();

            // If currently listening in live mode -> Stop!
            if (isLiveListening) {
                if (liveRecognition) liveRecognition.stop();
                isLiveListening = false;
                speechBaseText = chatInput.value ? chatInput.value.trim() : '';
                if (micBtn) micBtn.classList.remove('listening');
                chatInput.placeholder = "Type or speak a message...";
                return;
            }

            // If currently recording via MediaRecorder -> Stop & Transcribe!
            if (isRecording) {
                stopAndTranscribe();
                return;
            }

            // Always lock in current text before starting recording
            speechBaseText = chatInput.value ? chatInput.value.trim() : '';

            // Start Live or MediaRecorder recording
            if (liveRecognition && !isDesktopApp) {
                try {
                    liveRecognition.start();
                } catch (err) {
                    console.warn("liveRecognition start error, switching fallback:", err);
                    liveRecognition = null;
                    startMediaRecorderFallback();
                }
            } else {
                startMediaRecorderFallback();
            }
        });
    }

    // Load Chat History from Session
    async function loadChatHistory() {
        try {
            const response = await fetch('/api/chat/history');
            const data = await response.json();
            if (data.success && data.history && data.history.length > 0) {
                chatBody.innerHTML = '';
                appendMessage(defaultGreeting, 'bot');

                data.history.forEach(msg => {
                    const sender = msg.role === 'user' ? 'user' : 'bot';
                    appendMessage(msg.content, sender);
                });
            }
        } catch (err) {
            console.warn('Could not load chat history:', err);
        }
    }

    // Toggle Chat Drawer & Make Button Draggable
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let hasMoved = false;

    function dragStart(e) {
        if (e.type === 'touchstart') {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        } else {
            startX = e.clientX;
            startY = e.clientY;
        }

        const rect = toggleBtn.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        
        hasMoved = false;
        isDragging = true;

        document.addEventListener('mousemove', dragMove, { passive: false });
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('touchmove', dragMove, { passive: false });
        document.addEventListener('touchend', dragEnd);
    }

    function dragMove(e) {
        if (!isDragging) return;
        
        let clientX, clientY;
        if (e.type === 'touchmove') {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        const dx = clientX - startX;
        const dy = clientY - startY;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
            hasMoved = true;
        }

        if (hasMoved) {
            if (e.cancelable) e.preventDefault();

            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;

            const padding = 10;
            const btnWidth = toggleBtn.offsetWidth;
            const btnHeight = toggleBtn.offsetHeight;
            const maxX = window.innerWidth - btnWidth - padding;
            const maxY = window.innerHeight - btnHeight - padding;

            newLeft = Math.max(padding, Math.min(newLeft, maxX));
            newTop = Math.max(padding, Math.min(newTop, maxY));

            toggleBtn.style.right = 'auto';
            toggleBtn.style.bottom = 'auto';
            toggleBtn.style.left = newLeft + 'px';
            toggleBtn.style.top = newTop + 'px';
        }
    }

    function dragEnd(e) {
        if (!isDragging) return;
        
        setTimeout(() => {
            isDragging = false;
        }, 50);

        document.removeEventListener('mousemove', dragMove);
        document.removeEventListener('mouseup', dragEnd);
        document.removeEventListener('touchmove', dragMove);
        document.removeEventListener('touchend', dragEnd);
    }

    toggleBtn.addEventListener('mousedown', dragStart);
    toggleBtn.addEventListener('touchstart', dragStart, { passive: true });

    // Native click event to toggle chat (only fires if button wasn't dragged)
    toggleBtn.addEventListener('click', (e) => {
        if (hasMoved) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        drawer.classList.toggle('active');
        if (drawer.classList.contains('active')) {
            loadChatHistory();
            chatInput.focus();
        }
    });

    closeBtn.addEventListener('click', () => {
        drawer.classList.remove('active');
        if (isLiveListening && liveRecognition) liveRecognition.stop();
        if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    });

    // Clear Chat / Start New Chat
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            if (confirm('Start a new chat session?')) {
                if (isLiveListening && liveRecognition) liveRecognition.stop();
                if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
                if ('speechSynthesis' in window) window.speechSynthesis.cancel();
                try {
                    await fetch('/api/chat/history', { method: 'DELETE' });
                } catch (e) {}
                chatBody.innerHTML = '';
                appendMessage(defaultGreeting, 'bot');
            }
        });
    }

    // Form Submit Handler
    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;

        if (isLiveListening && liveRecognition) { liveRecognition.stop(); isLiveListening = false; }
        if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); isRecording = false; }
        if (micBtn) micBtn.classList.remove('listening');
        chatInput.placeholder = 'Type or speak a message...';

        // User Message UI
        appendMessage(text, 'user');
        chatInput.value = '';
        chatInput.style.height = '38px';

        // Bot Loading UI
        const loadingDiv = appendMessage('Thinking...', 'bot');

        try {
            const response = await fetch('/api/chat/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
            });

            const data = await response.json();
            const replyText = data.success ? (data.reply || "Done.") : (data.error || "Failed to get AI response.");
            
            loadingDiv.remove();
            appendMessage(replyText, 'bot');
        } catch (err) {
            loadingDiv.remove();
            appendMessage("⚠️ Connection reset while container was rebuilding. Please click Send again!", 'bot');
        }
    });

    // --- Dynamic Textarea Auto-Resizing (Max 5 lines with scrollbar, matching ChatGPT) ---
    function adjustInputHeight() {
        if (!chatInput) return;
        chatInput.style.height = '38px';
        const scrollH = chatInput.scrollHeight;
        if (scrollH > 38) {
            chatInput.style.height = Math.min(scrollH, 110) + 'px';
        }
    }

    chatInput.addEventListener('input', adjustInputHeight);

    // Enter to submit (Shift+Enter for newline)
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
    });

    loadChatHistory();
});
