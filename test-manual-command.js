
import { TelegramMessenger } from './dist/sentinel/TelegramMessenger.js';
import EventEmitter from 'events';

// Mock TelegramBot
class MockBot extends EventEmitter {
    constructor() { super(); }

    // Stub methods matching TelegramBot interface used
    sendMessage(chatId, text) {
        console.log(`[MockBot] Send to ${chatId}: ${text}`);
        return Promise.resolve();
    }

    onText(regex, callback) {
        this.on('text_event', (msg) => {
            const match = msg.text.match(regex);
            if (match) {
                callback(msg, match);
            }
        });
    }
}

// Mock Profiler
class MockProfiler {
    async analyzeMarket(tokenId, conditionId, currentPrice) {
        console.log(`[MockProfiler] Analyzing ${tokenId}...`);
        // Return dummy ScoreResult[]
        return [
            {
                address: '0xSuspiciousDude',
                totalScore: 85,
                details: ['Testing Purposes'],
                profile: { label: 'Insider' }
            }
        ];
    }
}

async function test() {
    console.log("=== Starting Telegram Command Test ===");

    const mockBot = new MockBot();
    const mockProfiler = new MockProfiler();

    // Inject mocks
    const messenger = new TelegramMessenger(mockProfiler, mockBot);

    // Force chatId to match our test user
    const chatId = 12345;
    messenger.chatId = chatId.toString(); // JS allows accessing private props usually or internal behavior

    // Mock Gamma response
    messenger.gamma = {
        getMarketMetadataBySlug: async (slug) => {
            console.log(`[MockGamma] Resolving slug: ${slug}`);
            return {
                id: "123",
                conditionId: "0xabc",
                title: "Test Market",
                tokenIds: ["token123"]
            };
        }
    };

    console.log(`\n1. Sending /check command from ID ${chatId}...`);
    // Simulate /check with a URL
    mockBot.emit('text_event', {
        chat: { id: chatId },
        text: '/check https://polymarket.com/event/test-slug'
    });

    // Wait for event loop
}

test().catch(console.error);
