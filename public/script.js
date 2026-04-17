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
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to fetch images');
        }

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

searchBtn.addEventListener('click', fetchImages);
dateInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') fetchImages();
});
downloadBtn.addEventListener('click', downloadImages);
