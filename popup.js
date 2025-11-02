// Load saved settings
chrome.storage.sync.get(['apiKey', 'provider'], function(result) {
  if (result.apiKey) {
    document.getElementById('apiKey').value = result.apiKey;
    document.getElementById('scanButton').disabled = false;
  }
  if (result.provider) {
    document.getElementById('provider').value = result.provider;
  }
  updateApiKeyHelp();
});

// Update help text based on provider
document.getElementById('provider').addEventListener('change', updateApiKeyHelp);

function updateApiKeyHelp() {
  const provider = document.getElementById('provider').value;
  const helpText = document.getElementById('apiKeyHelp');
  
  if (provider === 'groq') {
    helpText.innerHTML = 'Get free Groq API key at: <a href="https://console.groq.com" target="_blank">console.groq.com</a>';
  } else {
    helpText.innerHTML = 'Get OpenAI API key at: <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>';
  }
}

// Save API key
document.getElementById('saveKey').addEventListener('click', function() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const provider = document.getElementById('provider').value;
  
  if (!apiKey) {
    showStatus('Please enter an API key', 'error');
    return;
  }
  
  chrome.storage.sync.set({ apiKey: apiKey, provider: provider }, function() {
    showStatus(`${provider === 'groq' ? 'Groq' : 'OpenAI'} API key saved successfully!`, 'success');
    document.getElementById('scanButton').disabled = false;
  });
});

// Scan page button
document.getElementById('scanButton').addEventListener('click', async function() {
  const apiKey = document.getElementById('apiKey').value.trim();
  
  if (!apiKey) {
    showStatus('Please save your API key first', 'error');
    return;
  }
  
  showStatus('Scanning page for questions...', 'info');
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: scanPageForQuestions
    });
    
    showStatus('Scan initiated! Check the page for highlights.', 'success');
  } catch (error) {
    console.error('Error:', error);
    showStatus('Error: ' + error.message, 'error');
  }
});

function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = 'status ' + type;
  
  if (type === 'success') {
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }
}

function scanPageForQuestions() {
  window.postMessage({ type: 'SCAN_QUESTIONS' }, '*');
}