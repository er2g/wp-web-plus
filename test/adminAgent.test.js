const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const AdminAgent = require('../services/adminAgent');
const aiService = require('../services/aiService');

const originalGenerateJson = aiService.generateJson;

test.afterEach(() => {
    aiService.generateJson = originalGenerateJson;
});

test('admin agent trims trailing braces on valid reply', async () => {
    aiService.generateJson = async () => ({
        thought: 'clean but trailing brace',
        tool_name: null,
        tool_params: null,
        final_response: 'Merhaba }'
    });

    const agent = new AdminAgent({ chats: {}, scripts: {} });
    const reply = await agent.process([], 'Deneme', { apiKey: 'k', provider: 'gemini' });

    assert.equal(reply, 'Merhaba');
});

test('admin agent retries when final response is garbage and returns clean reply', async () => {
    const responses = [
        {
            thought: 'bad output',
            tool_name: null,
            tool_params: null,
            final_response: '}'
        },
        {
            thought: 'second try',
            tool_name: null,
            tool_params: null,
            final_response: 'Temiz cevap'
        }
    ];
    let idx = 0;
    aiService.generateJson = async () => responses[Math.min(idx++, responses.length - 1)];

    const agent = new AdminAgent({ chats: {}, scripts: {} });
    const reply = await agent.process([], 'Deneme', { apiKey: 'k', provider: 'gemini' });

    assert.equal(reply, 'Temiz cevap');
    assert.equal(idx >= 2, true);
});

test('admin agent falls back when repeated garbage responses occur using tool result', async () => {
    const responses = [
        {
            thought: 'create script',
            tool_name: 'create_script',
            tool_params: {
                name: 'Test Bot',
                description: 'desc',
                code: 'code',
                filter: JSON.stringify({ chatIds: ['123@c.us'] })
            },
            final_response: null
        },
        {
            thought: 'bad output loop',
            tool_name: null,
            tool_params: null,
            final_response: '}'
        },
        {
            thought: 'bad output loop 2',
            tool_name: null,
            tool_params: null,
            final_response: '}'
        }
    ];
    let idx = 0;
    aiService.generateJson = async () => responses[Math.min(idx++, responses.length - 1)];

    const db = {
        scripts: {
            create: { run: () => ({ lastInsertRowid: 77 }) }
        }
    };

    const agent = new AdminAgent(db);
    const reply = await agent.process([], 'Deneme', { apiKey: 'k', provider: 'gemini' });

    assert.match(reply, /Script created successfully/i);
});

test('admin agent falls back when repeated garbage responses occur', async () => {
    aiService.generateJson = async () => ({
        thought: 'bad output loop',
        tool_name: null,
        tool_params: null,
        final_response: '}'
    });

    const agent = new AdminAgent({ chats: {}, scripts: {} });
    const reply = await agent.process([], 'Deneme', { apiKey: 'k', provider: 'gemini' });

    assert.match(reply, /Talep alindi/i);
});
