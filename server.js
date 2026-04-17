require('dotenv').config();
const express = require('express');
const cors = require('cors');
const archiver = require('archiver');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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
        
        let count = 1;
        for (const url of images) {
            const response = await fetch(url);
            if (response.ok) {
                const contentType = response.headers.get('content-type') || '';
                const ext = contentType.includes('png') ? 'png' : 
                            contentType.includes('webp') ? 'webp' :
                            contentType.includes('gif') ? 'gif' : 'jpg';
                const zeroPad = String(count).padStart(3, '0');
                
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                archive.append(buffer, { name: `image_${zeroPad}.${ext}` });
                count++;
            }
        }
        
        await archive.finalize();
    } catch (e) {
        console.error("ZIP Error:", e);
        if (!res.headersSent) res.status(500).send("Error creating zip");
    }
});

// Fallback to index.html for unknown routes (useful if you expand frontend)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT} at 0.0.0.0`);
});
