const messagesList = document.getElementById('messagesList');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');

let history = []; // Stores conversation history context

// Auto-resize textarea
messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    if (this.value === '') this.style.height = 'auto';
});

// Send on Enter (Shift+Enter for newline)
messageInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    // Add user message to UI
    appendMessage('user', text);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    
    // Disable input
    messageInput.disabled = true;
    sendBtn.disabled = true;
    typingIndicator.style.display = 'block';

    try {
        const response = await fetch('/api/ai/admin-chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: text,
                history: history
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Server error');
        }

        const data = await response.json();
        const reply = data.response;

        // Add assistant message to UI
        appendMessage('assistant', reply);

        // Update history (keep last 20 turns to save tokens)
        history.push({ role: 'user', text: text });
        history.push({ role: 'assistant', text: reply });
        if (history.length > 20) history = history.slice(-20);

    } catch (error) {
        appendMessage('system', 'Error: ' + error.message);
    } finally {
        messageInput.disabled = false;
        sendBtn.disabled = false;
        typingIndicator.style.display = 'none';
        messageInput.focus();
    }
}

function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    
    // Simple markdown-ish formatting for code blocks
    let formatted = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Replace code blocks ```...```
    formatted = formatted.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    
    // Replace inline code `...`
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Replace newlines
    formatted = formatted.replace(/\n/g, '<br>');

    div.innerHTML = formatted;
    messagesList.appendChild(div);
    messagesList.scrollTop = messagesList.scrollHeight;
}
