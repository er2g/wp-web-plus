const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const AdminAgent = require('../services/adminAgent');
const aiService = require('../services/aiService');

const originalGenerateJson = aiService.generateJson;

test.afterEach(() => {
    aiService.generateJson = originalGenerateJson;
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
