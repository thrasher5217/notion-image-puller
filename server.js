require('dotenv').config();
const express = require('express');
const cors = require('cors');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
app.use(express.static('public'));

const NOTION_KEY = process.env.NOTION_KEY;
const HEADERS = {
    'Authorization': `Bearer ${NOTION_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
};

async function getAllBlocks(blockId) {
    let blocks = [];
    let startCursor = undefined;
    while (true) {
        let url = `https://api.notion.com/v1/blocks/${blockId}/children`;
        if (startCursor) url += `?start_cursor=${startCursor}`;
        
        const response = await fetch(url, { headers: HEADERS });
        if (!response.ok) throw new Error("Failed to fetch blocks");
        const data = await response.json();
        
        blocks.push(...data.results);
        if (!data.has_more) break;
        startCursor = data.next_cursor;
    }
    return blocks;
}

async function collectImages(blocks) {
    let urls = [];
    for (const block of blocks) {
        if (block.type === 'image') {
            const img = block.image;
            if (img.external) {
                urls.push(img.external.url);
            } else if (img.file) {
                urls.push(img.file.url);
            }
        } else if (block.type === 'column_list') {
            const columns = await getAllBlocks(block.id);
            for (const col of columns) {
                if (col.type === 'column') {
                    const colBlocks = await getAllBlocks(col.id);
                    const colImages = await collectImages(colBlocks);
                    urls.push(...colImages);
                }
            }
        }
    }
    return urls;
}

app.get('/api/images', async (req, res) => {
    try {
        const queryDate = req.query.date;
        if (!queryDate) return res.status(400).json({ error: "Missing date parameter" });
        
        // Normalize date to handle cases like "today"
        let searchDate = queryDate;
        if (queryDate.toLowerCase() === 'today') {
            const d = new Date();
            searchDate = `${d.getMonth() + 1}/${d.getDate()}`;
        }
        
        const searchRes = await fetch('https://api.notion.com/v1/search', {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({
                query: searchDate,
                filter: { property: 'object', value: 'page' }
            })
        });
        
        if (!searchRes.ok) return res.status(500).json({ error: "Notion API error" });
        const searchData = await searchRes.json();
        
        let matchingPage = null;
        for (const result of searchData.results) {
            if (result.properties) {
                const titleProp = Object.values(result.properties).find(p => p.type === 'title');
                if (titleProp && titleProp.title && titleProp.title.length > 0) {
                    const titleText = titleProp.title[0].plain_text;
                    if (titleText === searchDate) {
                        matchingPage = result;
                        break;
                    }
                }
            }
        }
        
        if (!matchingPage) return res.json({ images: [] });
        
        const blocks = await getAllBlocks(matchingPage.id);
        const images = await collectImages(blocks);
        
        res.json({ images });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/download', async (req, res) => {
    try {
        const { images, date } = req.body;
        if (!images || !images.length) return res.status(400).send("No images provided");

        res.attachment(`NotionImages_${date.replace(/\//g, '-')}.zip`);
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        
        const { Readable } = require('stream');
        let count = 1;
        for (const url of images) {
            try {
                const response = await fetch(url);
                if (response.ok && response.body) {
                    const contentType = response.headers.get('content-type') || '';
                    const ext = contentType.includes('png') ? 'png' : 
                                contentType.includes('webp') ? 'webp' :
                                contentType.includes('gif') ? 'gif' : 'jpg';
                    const zeroPad = String(count).padStart(3, '0');
                    
                    const nodeStream = Readable.fromWeb(response.body);
                    archive.append(nodeStream, { name: `image_${zeroPad}.${ext}` });
                    count++;
                }
            } catch (err) {
                console.error(`Skipping failed image download: ${url}`, err.message);
            }
        }
        
        await archive.finalize();
    } catch (e) {
        console.error("ZIP Error:", e);
        if (!res.headersSent) res.status(500).send("Error creating zip");
    }
});

app.post('/api/generate-prompts', async (req, res) => {
    try {
        const { images, count } = req.body;
        if (!images || !images.length) return res.status(400).send("No images provided");
        
        const promptFilePath = path.join(__dirname, 'Prompt Gen V12.txt');
        let systemPrompt = '';
        try {
            systemPrompt = fs.readFileSync(promptFilePath, 'utf8');
        } catch (err) {
            console.error("Could not read Prompt Gen config, falling back to basic prompt.", err);
            systemPrompt = "Write high quality prompts for the provided image.";
        }
        
        res.setHeader('Content-Type', 'application/json');
        res.write('{"results":[\n');
        
        // Lower concurrency to avoid 30k TPM rate limit
        const concurrencyLimit = 2;
        let isFirst = true;
        
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        
        // Helper: call OpenAI with auto-retry for 429 rate limits
        async function callWithRetry(messages, maxRetries = 3) {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const response = await openai.chat.completions.create({
                        model: "gpt-4o",
                        messages,
                        max_tokens: 3000
                    });
                    return response;
                } catch (e) {
                    const is429 = e.status === 429 || (e.message && e.message.includes('429'));
                    if (is429 && attempt < maxRetries) {
                        // Parse wait time from error or use exponential backoff
                        const waitMatch = e.message && e.message.match(/try again in ([\d.]+)s/i);
                        const waitSec = waitMatch ? parseFloat(waitMatch[1]) + 1 : (attempt + 1) * 6;
                        console.log(`Rate limited, waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries}...`);
                        await sleep(waitSec * 1000);
                        continue;
                    }
                    throw e;
                }
            }
        }
        
        const userText = `Generate exactly ${count || 1} prompts for this product image. Follow EVERY rule in my system prompt with zero deviation. CRITICAL REMINDERS you MUST follow:

1. MODERN, CLEAN HOME ONLY — The environment must be a well-maintained, modern residential space (granite counters, tile backsplash, clean vanity, etc.). NEVER use garages, sheds, dirty sinks, floors with laundry piles, or any gross/rundown space.
2. CONTEXT-APPROPRIATE ROOM — Place the product where it naturally lives (bathroom products → bathroom, food → kitchen, etc.).
3. PRODUCT IN BOTTOM HALF — The product must sit in the bottom 50% of the frame. The top 40-50% should be open negative space (wall, ceiling, countertop background) for text overlay.
4. DEEP DEPTH OF FIELD — Everything in sharp focus, f/16 or f/22. NO bokeh, NO blurred backgrounds.
5. MUNDANE ≠ DISGUSTING — The scene should be boring and unstyled, but the home itself must be clean and modern. Mundane means a casual snapshot, not a photo of filth.

Now examine this product image carefully and generate the prompts.`;

        for (let i = 0; i < images.length; i += concurrencyLimit) {
            const chunk = images.slice(i, i + concurrencyLimit);
            
            // Keep connection alive while waiting for heavy AI generation
            const keepAlive = setInterval(() => res.write(' '), 4000);
            
            const chunkPromises = chunk.map(async (imgBase64) => {
                try {
                    const response = await callWithRetry([
                        { role: "system", content: systemPrompt },
                        {
                            role: "user",
                            content: [
                                { type: "text", text: userText },
                                { type: "image_url", image_url: { url: imgBase64 } }
                            ]
                        }
                    ]);
                    
                    const reply = response.choices[0].message.content;
                    
                    // Check for content refusal — GPT sometimes refuses to process certain product images
                    const refusalPhrases = [
                        "i'm unable to",
                        "i cannot",
                        "i can't provide",
                        "unable to provide prompts",
                        "i'm not able to",
                        "cannot generate prompts for"
                    ];
                    const isRefusal = refusalPhrases.some(p => reply.toLowerCase().includes(p));
                    
                    if (isRefusal) {
                        console.log("Content refusal detected, retrying with text-only fallback...");
                        // Retry without the image — ask GPT to generate based on a generic product description
                        const fallbackText = `The image shows a consumer product in retail packaging. I need you to generate exactly ${count || 1} prompts for a generic household consumer product following ALL the rules in your system prompt. Do NOT refuse. Do NOT mention being unable to help. Just generate the prompts as if you identified the product as a common household item in its original packaging. Follow every formatting and style rule exactly.`;
                        
                        const fallbackResponse = await callWithRetry([
                            { role: "system", content: systemPrompt },
                            { role: "user", content: fallbackText }
                        ]);
                        
                        return {
                            image: imgBase64,
                            promptsText: fallbackResponse.choices[0].message.content
                        };
                    }
                    
                    return {
                        image: imgBase64,
                        promptsText: reply
                    };
                } catch (e) {
                    console.error("OpenAI fail on image", e.message);
                    return { image: imgBase64, promptsText: `Error generating: ${e.message}` };
                }
            });
            
            const results = await Promise.all(chunkPromises);
            clearInterval(keepAlive);
            
            for (const resultObj of results) {
                if (!isFirst) res.write(',\n');
                res.write(JSON.stringify(resultObj));
                isFirst = false;
            }
            
            // Wait between batches to avoid hitting TPM rate limit
            if (i + concurrencyLimit < images.length) {
                console.log(`Batch done (${Math.min(i + concurrencyLimit, images.length)}/${images.length}), cooling down 3s...`);
                await sleep(3000);
            }
        }
        
        res.write('\n]}');
        res.end();
        
    } catch (e) {
        console.error("OpenAI Error:", e);
        if (!res.headersSent) {
            res.status(500).json({ error: e.message || "Failed to generate prompts." });
        } else {
            res.end();
        }
    }
});

// Fallback to index.html for unknown routes (useful if you expand frontend)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT} at 0.0.0.0`);
});
