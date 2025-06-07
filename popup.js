document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    tabs: document.querySelectorAll('.tab'),
    tabPanels: document.querySelectorAll('.tab-panel'),
    statusDiv: document.getElementById('status'),
    
    apiKeyInput: document.getElementById('apiKey'),
    retentionDaysInput: document.getElementById('retentionDays'),
    saveButton: document.getElementById('saveSettings'),
    clearButton: document.getElementById('clearTransfers'),
    
    domainInput: document.getElementById('domainInput'),
    addDomainBtn: document.getElementById('addDomainBtn'),
    domainsDisplay: document.getElementById('domainsDisplay'),
    domainTags: document.getElementById('domainTags'),
    autoDetectBtn: document.getElementById('autoDetectBtn'),
    addDefaultBtn: document.getElementById('addDefaultBtn'),
    resetDomainsButton: document.getElementById('resetDomains'),
    
    logLevel: document.getElementById('logLevel'),
    logComponent: document.getElementById('logComponent'),
    logLimit: document.getElementById('logLimit'),
    logsContainer: document.getElementById('logsContainer'),
    refreshLogsButton: document.getElementById('refreshLogs'),
    clearLogsButton: document.getElementById('clearLogs')
  };

  const defaultDomains = ['thepiratebay.org', '1337x.to', 'rarbg.to', 'nyaa.si', 'eztv.re'];
  let currentDomains = new Set();

  await loadSettings();
  await loadDomains();
  await loadLogs();
  setupEventListeners();

  function setupEventListeners() {
    elements.tabs.forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    elements.saveButton.addEventListener('click', saveSettings);
    elements.clearButton.addEventListener('click', clearTransferHistory);

    elements.domainInput.addEventListener('keydown', handleDomainInput);
    elements.domainInput.addEventListener('paste', handleDomainPaste);
    elements.addDomainBtn.addEventListener('click', () => {
      const input = elements.domainInput.value.trim();
      if (input && addDomain(input)) {
        elements.domainInput.value = '';
      }
    });
    elements.autoDetectBtn.addEventListener('click', autoDetectDomain);
    elements.addDefaultBtn.addEventListener('click', addDefaultDomains);
    elements.resetDomainsButton.addEventListener('click', resetDomains);

    elements.refreshLogsButton.addEventListener('click', loadLogs);
    elements.clearLogsButton.addEventListener('click', clearLogs);
    elements.logLevel.addEventListener('change', loadLogs);
    elements.logComponent.addEventListener('change', loadLogs);
    elements.logLimit.addEventListener('change', loadLogs);
  }

  function switchTab(tabName) {
    elements.tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    elements.tabPanels.forEach(panel => {
      panel.classList.toggle('active', panel.id === tabName);
    });

    if (tabName === 'logs') {
      loadLogs();
    } else if (tabName === 'domains') {
      loadDomains();
    }
  }

  function showStatus(message, type) {
    elements.statusDiv.textContent = message;
    elements.statusDiv.className = `status ${type}`;
    elements.statusDiv.style.display = 'block';
    
    setTimeout(() => {
      elements.statusDiv.style.display = 'none';
    }, 4000);
  }

  function showButtonLoading(button, loading, text = null) {
    if (loading) {
      button.disabled = true;
      const originalText = button.textContent;
      button.dataset.originalText = originalText;
      button.innerHTML = `<span class="loading-spinner"></span>${text || 'Loading...'}`;
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalText || button.textContent;
    }
  }

  async function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: 'No response' });
        }
      });
    });
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(['putioApiKey', 'retentionDays']);
      
      if (result.putioApiKey) {
        elements.apiKeyInput.value = result.putioApiKey;
      }
      
      if (result.retentionDays) {
        elements.retentionDaysInput.value = result.retentionDays;
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  }

  async function saveSettings() {
    try {
      const apiKey = elements.apiKeyInput.value.trim();
      const retentionDays = parseInt(elements.retentionDaysInput.value) || 7;

      if (!apiKey) {
        showStatus('Please enter a valid API key', 'error');
        elements.apiKeyInput.focus();
        return;
      }

      if (retentionDays < 1 || retentionDays > 30) {
        showStatus('Retention days must be between 1 and 30', 'error');
        elements.retentionDaysInput.focus();
        return;
      }

      showButtonLoading(elements.saveButton, true, 'Saving...');

      await chrome.storage.local.set({
        putioApiKey: apiKey,
        retentionDays: retentionDays
      });
      
      showStatus('Settings saved successfully!', 'success');
    } catch (error) {
      console.error('Error saving settings:', error);
      showStatus('Failed to save settings', 'error');
    } finally {
      showButtonLoading(elements.saveButton, false);
    }
  }

  async function clearTransferHistory() {
    try {
      if (!confirm('Clear all transfer history? This cannot be undone.')) {
        return;
      }

      showButtonLoading(elements.clearButton, true, 'Clearing...');
      await chrome.storage.local.remove(['transfers']);
      showStatus('Transfer history cleared!', 'success');
    } catch (error) {
      console.error('Error clearing transfer history:', error);
      showStatus('Failed to clear transfer history', 'error');
    } finally {
      showButtonLoading(elements.clearButton, false);
    }
  }

  function normalizeDomain(input) {
    if (!input || typeof input !== 'string') return null;
    let domain = input.trim().toLowerCase();
    domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
    domain = domain.split('/')[0].split(':')[0].split('?')[0].split('#')[0];
    if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain) || domain.length > 253) return null;
    if (!domain.includes('.') && !['localhost', 'local'].includes(domain)) return null;
    return domain;
  }

  function validateDomainFormat(domain) {
    if (!domain || typeof domain !== 'string') return false;
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return domainRegex.test(normalized) &&
           normalized.length <= 253 &&
           !normalized.includes('..') &&
           !normalized.includes('@') &&
           !normalized.startsWith('.') &&
           !normalized.endsWith('.') &&
           normalized.split('.').every(label => label.length <= 63);
  }

  function createDomainTag(domain) {
    const tag = document.createElement('div');
    tag.className = 'domain-tag';
    tag.dataset.domain = domain;
    
    const text = document.createElement('span');
    text.className = 'domain-tag-text';
    text.textContent = domain;
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'domain-tag-remove';
    removeBtn.innerHTML = '×';
    removeBtn.title = 'Remove domain';
    
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeDomain(domain, tag);
    });
    
    tag.appendChild(text);
    tag.appendChild(removeBtn);
    
    return tag;
  }

  function addDomain(domain) {
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      showStatus('Invalid domain format', 'error');
      return false;
    }

    if (!validateDomainFormat(normalized)) {
      showStatus('Invalid domain format', 'error');
      return false;
    }

    if (currentDomains.has(normalized)) {
      showStatus('Domain already exists', 'error');
      return false;
    }

    currentDomains.add(normalized);
    const tag = createDomainTag(normalized);
    elements.domainTags.appendChild(tag);
    
    updateDomainDisplay();
    updateDomains();
    return true;
  }

  function removeDomain(domain, tagElement) {
    currentDomains.delete(domain);
    if (tagElement.parentNode) {
      tagElement.parentNode.removeChild(tagElement);
    }
    updateDomainDisplay();
    updateDomains();
  }

  function updateDomainDisplay() {
    if (currentDomains.size === 0) {
      elements.domainsDisplay.classList.add('empty');
      elements.domainTags.innerHTML = '<span style="color: #a0aec0; font-style: italic; font-size: 12px;">No domains added yet</span>';
    } else {
      elements.domainsDisplay.classList.remove('empty');
      const emptyMessage = elements.domainTags.querySelector('span');
      if (emptyMessage && emptyMessage.textContent.includes('No domains')) {
        emptyMessage.remove();
      }
    }
  }

  function handleDomainInput(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const input = elements.domainInput.value.trim();
      if (input && addDomain(input)) {
        elements.domainInput.value = '';
      }
    }
  }

  function handleDomainPaste(e) {
    setTimeout(() => {
      const pastedText = elements.domainInput.value;
      if (pastedText.includes('\n') || pastedText.includes(',') || pastedText.includes(' ')) {
        const domains = pastedText.split(/[\n,\s]+/).filter(d => d.trim());
        let addedCount = 0;
        
        domains.forEach(domain => {
          if (addDomain(domain.trim())) {
            addedCount++;
          }
        });
        
        elements.domainInput.value = '';
        if (addedCount > 0) {
          showStatus(`Added ${addedCount} domains`, 'success');
        }
      }
    }, 10);
  }

  function addDefaultDomains() {
    let addedCount = 0;
    defaultDomains.forEach(domain => {
      if (!currentDomains.has(domain)) {
        currentDomains.add(domain);
        const tag = createDomainTag(domain);
        elements.domainTags.appendChild(tag);
        addedCount++;
      }
    });
    
    if (addedCount > 0) {
      updateDomainDisplay();
      updateDomains();
      showStatus(`Added ${addedCount} default domains`, 'success');
    } else {
      showStatus('All default domains already added', 'error');
    }
  }

  async function autoDetectDomain() {
    try {
      const originalText = elements.autoDetectBtn.innerHTML;
      elements.autoDetectBtn.disabled = true;
      elements.autoDetectBtn.innerHTML = '⏳';
      
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab || !tab.url) {
        showStatus('Cannot detect domain from current tab', 'error');
        return;
      }
      
      const url = new URL(tab.url);
      const domain = normalizeDomain(url.hostname);
      
      if (!domain) {
        showStatus('Invalid domain detected', 'error');
        return;
      }
      
      if (addDomain(domain)) {
        showStatus(`Auto-detected and added: ${domain}`, 'success');
      }
      
    } catch (error) {
      console.error('Error auto-detecting domain:', error);
      showStatus('Failed to auto-detect domain', 'error');
    } finally {
      elements.autoDetectBtn.disabled = false;
      elements.autoDetectBtn.innerHTML = '🪄';
    }
  }

  async function resetDomains() {
    try {
      if (!confirm('Reset to default domains? This will replace your current whitelist.')) {
        return;
      }

      showButtonLoading(elements.resetDomainsButton, true, 'Resetting...');

      elements.domainTags.innerHTML = '';
      currentDomains.clear();
      
      defaultDomains.forEach(domain => {
        currentDomains.add(domain);
        const tag = createDomainTag(domain);
        elements.domainTags.appendChild(tag);
      });

      updateDomainDisplay();
      await updateDomains();
      showStatus('Domains reset to defaults!', 'success');
    } catch (error) {
      console.error('Error resetting domains:', error);
      showStatus('Failed to reset domains', 'error');
    } finally {
      showButtonLoading(elements.resetDomainsButton, false);
    }
  }

  async function updateDomains() {
    try {
      const domainsArray = Array.from(currentDomains);
      const response = await sendMessage({ 
        action: 'updateWhitelist', 
        domains: domainsArray 
      });

      if (!response.success) {
        console.error('Failed to update domains:', response.error);
        showStatus('Failed to update domains', 'error');
      }
    } catch (error) {
      console.error('Error updating domains:', error);
    }
  }

  async function loadDomains() {
    try {
      const response = await sendMessage({ action: 'getWhitelist' });
      
      if (response.success && Array.isArray(response.domains)) {
        elements.domainTags.innerHTML = '';
        currentDomains.clear();
        
        response.domains.forEach(domain => {
          currentDomains.add(domain);
          const tag = createDomainTag(domain);
          elements.domainTags.appendChild(tag);
        });
        
        updateDomainDisplay();
      } else {
        console.error('Failed to load domains:', response.error);
        elements.domainsDisplay.classList.add('empty');
        elements.domainTags.innerHTML = '<span style="color: #e53e3e;">❌ Error loading domains</span>';
      }
    } catch (error) {
      console.error('Error loading domains:', error);
      elements.domainsDisplay.classList.add('empty');
      elements.domainTags.innerHTML = '<span style="color: #e53e3e;">❌ Error loading domains</span>';
    }
  }

  async function loadLogs() {
    try {
      showButtonLoading(elements.refreshLogsButton, true, 'Loading...');
      
      const level = elements.logLevel.value || null;
      const component = elements.logComponent.value || null;
      const limit = parseInt(elements.logLimit.value) || 30;

      const response = await sendMessage({ 
        action: 'getLogs',
        level,
        component,
        limit
      });

      if (response.success && Array.isArray(response.logs)) {
        const logs = response.logs;
        
        if (logs.length > 0) {
          elements.logsContainer.innerHTML = logs.map(log => {
            const time = new Date(log.timestamp).toLocaleTimeString('en-US', { 
              hour12: false, 
              hour: '2-digit', 
              minute: '2-digit' 
            });
            return `
              <div class="log-entry log-level-${log.level}">
                <span style="color: #718096;">[${time}]</span>
                <span style="color: #a0aec0;">[${log.level}]</span>
                <span style="color: #cbd5e0;">[${escapeHtml(log.component)}]</span>
                ${escapeHtml(log.message)}
                ${log.data ? `<br><span style="margin-left: 14px; color: #9ca3af; font-size: 9px;">${escapeHtml(log.data.substring(0, 120))}${log.data.length > 120 ? '...' : ''}</span>` : ''}
              </div>
            `;
          }).join('');
        } else {
          elements.logsContainer.innerHTML = `
            <div class="log-entry" style="color: #718096;">
              No logs found for the selected criteria
            </div>
          `;
        }
      } else {
        elements.logsContainer.innerHTML = `
          <div class="log-entry" style="color: #fc8181;">
            Error loading logs: ${escapeHtml(response.error || 'Unknown error')}
          </div>
        `;
      }
    } catch (error) {
      console.error('Error loading logs:', error);
      elements.logsContainer.innerHTML = `
        <div class="log-entry" style="color: #fc8181;">
          Error loading logs: ${escapeHtml(error.message)}
        </div>
      `;
    } finally {
      showButtonLoading(elements.refreshLogsButton, false);
    }
  }

  async function clearLogs() {
    try {
      if (!confirm('Clear all extension logs? This cannot be undone.')) {
        return;
      }

      showButtonLoading(elements.clearLogsButton, true, 'Clearing...');

      const response = await sendMessage({ action: 'clearLogs' });

      if (response.success) {
        elements.logsContainer.innerHTML = `
          <div class="log-entry" style="color: #68d391;">
            Logs cleared successfully
          </div>
        `;
        showStatus('Logs cleared successfully!', 'success');
      } else {
        showStatus('Failed to clear logs: ' + (response.error || 'Unknown error'), 'error');
      }
    } catch (error) {
      console.error('Error clearing logs:', error);
      showStatus('Failed to clear logs', 'error');
    } finally {
      showButtonLoading(elements.clearLogsButton, false);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});