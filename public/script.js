const dateInput = document.getElementById('dateInput');
const searchBtn = document.getElementById('searchBtn');
const resultsContainer = document.getElementById('resultsContainer');
const imageGrid = document.getElementById('imageGrid');
const resultsTitle = document.getElementById('resultsTitle');
const statusMessage = document.getElementById('statusMessage');
const downloadBtn = document.getElementById('downloadBtn');

let currentImages = [];
let currentDate = '';

function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    statusMessage.classList.remove('hidden');
}

function hideStatus() {
    statusMessage.classList.add('hidden');
}

async function fetchImages() {
    const date = dateInput.value.trim();
    if (!date) {
        showStatus('Please enter a date.', 'error');
        return;
    }

    // Reset UI
    hideStatus();
    resultsContainer.classList.add('hidden');
    imageGrid.innerHTML = '';
    
    // Loading state
    searchBtn.disabled = true;
    showStatus('Searching Notion and extracting images...', 'loading');

    try {
        const response = await fetch(`/api/images?date=${encodeURIComponent(date)}`);
        if (!response.ok) {
            const textErr = await response.text();
            throw new Error(`Server returned ${response.status}: ${textErr}`);
        }
        const data = await response.json();

        currentImages = data.images || [];
        currentDate = date;

        if (currentImages.length === 0) {
            showStatus('No images found for that date.', 'error');
            searchBtn.disabled = false;
            return;
        }

        // Display results
        hideStatus();
        resultsTitle.textContent = `Images Found: ${currentImages.length}`;
        
        currentImages.forEach((url, i) => {
            const card = document.createElement('div');
            card.className = 'img-card';
            
            const img = document.createElement('img');
            img.src = url;
            img.alt = `Notion image ${i + 1}`;
            img.loading = 'lazy';
            
            card.appendChild(img);
            imageGrid.appendChild(card);
        });

        resultsContainer.classList.remove('hidden');

    } catch (error) {
        showStatus(error.message, 'error');
    } finally {
        searchBtn.disabled = false;
    }
}

async function downloadImages() {
    if (!currentImages.length) return;

    downloadBtn.disabled = true;
    const originalText = downloadBtn.innerHTML;
    downloadBtn.innerHTML = 'Generating ZIP...';

    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: currentImages, date: currentDate })
        });

        if (!response.ok) throw new Error('Failed to create ZIP');

        // Trigger download
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `NotionImages_${currentDate.replace(/\//g, '-')}.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();

    } catch (error) {
        alert(error.message);
    } finally {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = originalText;
    }
}

// ====== PROMPTER & TABS LOGIC ======
const tabs = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => {
            c.classList.add('hidden');
            c.classList.remove('active');
        });
        
        tab.classList.add('active');
        const target = document.getElementById(tab.dataset.target);
        target.classList.remove('hidden');
        target.classList.add('active');
    });
});

let prompterImages = [];

const prompterFiles = document.getElementById('prompterFiles');
const promptCount = document.getElementById('promptCount');
const generateBtn = document.getElementById('generateBtn');
const prompterStatus = document.getElementById('prompterStatus');
const prompterResultsContainer = document.getElementById('prompterResultsContainer');
const prompterResultsList = document.getElementById('prompterResultsList');
const transferToPrompterBtn = document.getElementById('transferToPrompterBtn');

function showPrompterStatus(msg, type) {
    prompterStatus.textContent = msg;
    prompterStatus.className = `status-message ${type}`;
    prompterStatus.classList.remove('hidden');
}

prompterFiles.addEventListener('change', async (e) => {
    prompterImages = [];
    const files = Array.from(e.target.files);
    for (const file of files) {
        const reader = new FileReader();
        reader.onload = () => prompterImages.push(reader.result);
        reader.readAsDataURL(file);
    }
    showPrompterStatus(`Loaded ${files.length} images from computer.`, 'success');
});

if(transferToPrompterBtn) {
    transferToPrompterBtn.addEventListener('click', () => {
        if (!currentImages.length) {
            alert("No images found! Please fetch Notion images first.");
            return;
        }
        prompterImages = [...currentImages];
        document.querySelector('[data-target="prompter-tab"]').click();
        showPrompterStatus(`Transferred ${prompterImages.length} images from Notion into Prompter.`, 'success');
    });
}

generateBtn.addEventListener('click', async () => {
    if (!prompterImages.length) {
        showPrompterStatus("Please upload images or transfer them from Notion first.", "error");
        return;
    }
    
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';
    prompterResultsContainer.classList.add('hidden');
    prompterResultsList.innerHTML = '';
    showPrompterStatus('Running OpenAI Vision Prompter...', 'loading');
    
    try {
        const res = await fetch('/api/generate-prompts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: prompterImages, count: promptCount.value || 1 })
        });
        
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`API Error ${res.status}: ${errText}`);
        }
        
        const data = await res.json();
        
        prompterStatus.classList.add('hidden');
        prompterResultsContainer.classList.remove('hidden');
        
        data.results.forEach((item) => {
            const group = document.createElement('div');
            group.className = 'prompt-group';
            
            const img = document.createElement('img');
            img.src = item.image;
            group.appendChild(img);
            
            const matches = [...item.promptsText.matchAll(/```(?:[\w]*\n)?([\s\S]*?)```/g)];
            if (matches && matches.length > 0) {
                matches.forEach((m, idx) => group.appendChild(createPromptItem(m[1].trim(), idx + 1)));
            } else {
                group.appendChild(createPromptItem(item.promptsText, 1));
            }
            
            prompterResultsList.appendChild(group);
        });
        
    } catch(err) {
        showPrompterStatus(err.message, 'error');
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Prompts';
    }
});

function createPromptItem(text, index) {
    const div = document.createElement('div');
    div.className = 'prompt-item';
    
    const numBadge = document.createElement('div');
    numBadge.className = 'prompt-number';
    numBadge.textContent = index;
    
    const content = document.createElement('span');
    content.textContent = text;
    
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => {
        navigator.clipboard.writeText(text);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    };
    
    div.appendChild(numBadge);
    div.appendChild(content);
    div.appendChild(btn);
    return div;
}

searchBtn.addEventListener('click', fetchImages);
dateInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') fetchImages();
});
downloadBtn.addEventListener('click', downloadImages);
