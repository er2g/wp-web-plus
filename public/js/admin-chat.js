const messagesList = document.getElementById('messagesList');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');

let history = []; // Stores conversation history context

// Auto-resize textarea is now handled in HTML inline script or CSS, 
// but we keep the event listener if needed for other logic.
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
        const response = await fetch('api/ai/admin-chat', {
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
        
        // Scroll to bottom
        messagesList.scrollTop = messagesList.scrollHeight;
    }
}

function appendMessage(role, text) {
    const rowDiv = document.createElement('div');
    const isUser = role === 'user';
    const isSystem = role === 'system';
    
    // Determine row class
    if (isSystem) {
        rowDiv.className = 'message-row system';
    } else {
        rowDiv.className = `message-row ${isUser ? 'sent' : 'received'}`;
    }
    
    // Bubble Div
    const bubbleDiv = document.createElement('div');
    if (isSystem) {
        bubbleDiv.className = 'message-bubble system';
    } else {
        bubbleDiv.className = `message-bubble ${isUser ? 'sent' : 'received'}`;
    }

    // Sender Name (Only for Assistant)
    if (!isUser && !isSystem) {
        const senderName = document.createElement('div');
        senderName.className = 'sender-name';
        senderName.textContent = 'AI Assistant';
        bubbleDiv.appendChild(senderName);
    }

    // Message Text with basic formatting
    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    
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

    textDiv.innerHTML = formatted;
    bubbleDiv.appendChild(textDiv);

    // Time
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    const now = new Date();
    timeDiv.textContent = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    bubbleDiv.appendChild(timeDiv);

    rowDiv.appendChild(bubbleDiv);
    messagesList.appendChild(rowDiv);
    
    // Scroll into view
    messagesList.scrollTop = messagesList.scrollHeight;
}