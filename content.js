console.log('AI Question Helper content script loaded!');

window.addEventListener('message', async function(event) {
  console.log('Message received:', event.data);
  if (event.source !== window) return;
  if (event.data.type === 'SCAN_QUESTIONS') {
    console.log('Starting scan...');
    await scanAndAnalyzeQuestions();
  }
});

async function scanAndAnalyzeQuestions() {
  console.log('scanAndAnalyzeQuestions called');
  
  // Always clear previous results first
  clearPreviousResults();
  
  const result = await chrome.storage.sync.get(['apiKey']);
  const apiKey = result.apiKey;
  console.log('API Key found:', apiKey ? 'Yes' : 'No');
  
  if (!apiKey) {
    alert('Please set your API key in the extension popup');
    return;
  }
  
  const questions = findQuestions();
  console.log('Questions found:', questions.length);
  console.log('Question details:', questions);
  
  if (questions.length === 0) {
    alert('No questions found on this page');
    return;
  }
  
  showLoadingIndicator(`Found ${questions.length} question(s). Analyzing...`);
  
  // Track which questions we've already processed in this scan
  const processedQuestions = new Set();
  
  for (let i = 0; i < questions.length; i++) {
    const questionKey = questions[i].text + questions[i].element.outerHTML.substring(0, 50);
    
    // Skip if we've already processed this exact question
    if (processedQuestions.has(questionKey)) {
      console.log('Skipping already processed question:', questions[i].text);
      continue;
    }
    processedQuestions.add(questionKey);
    
    try {
      console.log(`Analyzing question ${i + 1}:`, questions[i].text);
      updateLoadingIndicator(`Analyzing question ${i + 1} of ${questions.length}...`);
      await analyzeQuestion(questions[i], apiKey);
      await sleep(1500);
    } catch (error) {
      console.error('Error analyzing question:', error);
      addError(questions[i].element, 'Rate limit or API error - try again in a moment');
    }
  }
  
  hideLoadingIndicator();
  showCompletionMessage(`Analyzed ${questions.length} question(s)!`);
}

function clearPreviousResults() {
  document.querySelectorAll('.ai-answer-overlay, .ai-explanation, .ai-error-box').forEach(el => el.remove());
  document.querySelectorAll('[data-ai-checkmark="true"]').forEach(el => el.remove());
  
  document.querySelectorAll('[data-ai-highlighted="true"]').forEach(el => {
    el.style.border = '';
    el.style.borderRadius = '';
    el.style.padding = '';
    el.style.backgroundColor = '';
    el.style.animation = '';
    el.removeAttribute('data-ai-highlighted');
  });
  
  // Removed: Don't uncheck radio buttons since we're not checking them anymore
}

function findQuestions() {
  const questions = [];
  const seenQuestionTexts = new Set();
  const processedRadioGroups = new Set();
  
  // Strategy: Start with answer inputs, THEN find questions
  // This prevents false positives from random text on the page
  
  // === METHOD 1: Find radio button groups (multiple choice) ===
  const radioGroups = {};
  const allRadios = document.querySelectorAll('input[type="radio"]');
  
  // Group radios by name attribute
  allRadios.forEach(radio => {
    const name = radio.name;
    if (!name) return;
    
    if (!radioGroups[name]) {
      radioGroups[name] = [];
    }
    radioGroups[name].push(radio);
  });
  
  // Process each radio group
  Object.keys(radioGroups).forEach(groupName => {
    const radios = radioGroups[groupName];
    
    // Must have at least 2 options to be a valid question
    if (radios.length < 2) return;
    
    // Skip if already processed
    if (processedRadioGroups.has(groupName)) return;
    processedRadioGroups.add(groupName);
    
    const firstRadio = radios[0];
    
    // NOW find the question text for this radio group
    const questionElement = findQuestionTextNear(firstRadio);
    
    if (!questionElement) {
      console.log('No question text found for radio group:', groupName);
      return;
    }
    
    const questionText = questionElement.textContent.trim();
    
    // Skip duplicates
    if (seenQuestionTexts.has(questionText)) {
      console.log('Skipping duplicate question:', questionText);
      return;
    }
    
    // Must be reasonable length
    if (questionText.length < 10 || questionText.length > 1000) {
      console.log('Question text length invalid:', questionText.length);
      return;
    }
    
    seenQuestionTexts.add(questionText);
    
    // Extract choice text for each radio button
    const choices = radios.map(radio => {
      let labelText = extractChoiceText(radio, questionText);
      
      console.log(`Radio: value="${radio.value}", text="${labelText}"`);
      
      return {
        element: radio.closest('label') || radio.parentElement,
        text: labelText,
        inputElement: radio
      };
    });
    
    // Skip if we couldn't extract valid choices
    if (choices.every(c => !c.text || c.text === 'on' || c.text === '')) {
      console.log('Invalid choices for question:', questionText);
      return;
    }
    
    questions.push({
      element: questionElement,
      text: questionText,
      type: 'multiple-choice',
      choices: choices,
      parentElement: questionElement.parentElement
    });
  });
  
  // === METHOD 2: Find text inputs (fill-in questions) ===
  const textInputs = document.querySelectorAll('input[type="text"], textarea');
  
  textInputs.forEach(input => {
    // Skip if input looks like a search box, name field, etc.
    const placeholder = (input.placeholder || '').toLowerCase();
    const inputName = (input.name || '').toLowerCase();
    
    if (placeholder.includes('search') || placeholder.includes('email') || 
        placeholder.includes('name') || inputName.includes('search')) {
      return;
    }
    
    const questionElement = findQuestionTextNear(input);
    
    if (!questionElement) return;
    
    const questionText = questionElement.textContent.trim();
    
    // Skip duplicates
    if (seenQuestionTexts.has(questionText)) {
      return;
    }
    
    // Must look like a question (reasonable length + question indicators)
    const looksLikeQuestion = questionText.includes('?') || 
                              questionText.includes('___') ||
                              /^\d+[\).\:]/.test(questionText) ||
                              /^Question \d+/i.test(questionText);
    
    if (!looksLikeQuestion || questionText.length < 15 || questionText.length > 1000) {
      return;
    }
    
    seenQuestionTexts.add(questionText);
    
    questions.push({
      element: questionElement,
      text: questionText,
      type: 'fill-in',
      choices: [],
      parentElement: questionElement.parentElement,
      inputElement: input
    });
  });
  
  console.log('Found questions:', questions);
  return questions;
}

function extractChoiceText(radio, questionText) {
  let labelText = '';
  
  // Method 1: Find label that contains this radio
  const parentLabel = radio.closest('label');
  if (parentLabel) {
    labelText = parentLabel.textContent.trim();
  }
  
  // Method 2: Find label with matching 'for' attribute
  if (!labelText && radio.id) {
    const forLabel = document.querySelector(`label[for="${radio.id}"]`);
    if (forLabel) {
      labelText = forLabel.textContent.trim();
    }
  }
  
  // Method 3: Look at next sibling text
  if (!labelText) {
    let sibling = radio.nextSibling;
    while (sibling && sibling.nodeType === Node.TEXT_NODE) {
      const text = sibling.textContent.trim();
      if (text.length > 0) {
        labelText = text;
        break;
      }
      sibling = sibling.nextSibling;
    }
    
    // Also check next element sibling
    if (!labelText && radio.nextElementSibling) {
      labelText = radio.nextElementSibling.textContent.trim();
    }
  }
  
  // Method 4: Check parent element's text (excluding the question)
  if (!labelText || labelText === 'on') {
    const parent = radio.parentElement;
    if (parent) {
      // Get only the direct text content, not nested elements
      const directText = Array.from(parent.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent.trim())
        .join(' ')
        .trim();
      
      if (directText && directText !== 'on') {
        labelText = directText;
      } else {
        // Get all text but try to exclude the question
        const allText = parent.textContent.trim();
        if (allText && allText !== 'on' && allText !== questionText) {
          labelText = allText;
        }
      }
    }
  }
  
  // Fallback to radio value
  if (!labelText || labelText === 'on') {
    labelText = radio.value || '';
  }
  
  return labelText;
}

function findQuestionTextNear(inputElement) {
  // Method 1: Check closest label
  const label = inputElement.closest('label');
  if (label && label.textContent.trim().length > 10) {
    return label;
  }
  
  // Method 2: Look for question in previous siblings (more aggressive search)
  let sibling = inputElement.previousElementSibling;
  let depth = 0;
  
  while (sibling && depth < 10) { // Increased from 5 to 10
    const text = sibling.textContent.trim();
    if (text.length > 10 && text.length < 1000) { // Increased max length
      // Accept if it has question marks, numbered format, or starts with capital
      if (text.includes('?') || /^\d+[\).\:]/.test(text) || /^[A-Z]/.test(text) || text.includes('Question')) {
        return sibling;
      }
    }
    sibling = sibling.previousElementSibling;
    depth++;
  }
  
  // Method 3: Look in parent's siblings (for questions in separate containers)
  let parent = inputElement.parentElement;
  depth = 0;
  
  while (parent && depth < 5) { // Increased from 3 to 5
    // Check previous siblings of the parent
    let parentSibling = parent.previousElementSibling;
    let siblingDepth = 0;
    
    while (parentSibling && siblingDepth < 5) {
      const text = parentSibling.textContent.trim();
      if (text.length > 10 && text.length < 1000) {
        if (text.includes('?') || /^\d+[\).\:]/.test(text) || /^Question \d+/.test(text)) {
          return parentSibling;
        }
      }
      parentSibling = parentSibling.previousElementSibling;
      siblingDepth++;
    }
    
    // Also check children of parent
    for (let child of parent.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child !== inputElement && child !== inputElement.parentElement) {
        const text = child.textContent.trim();
        if (text.length > 10 && text.length < 1000) {
          if (text.includes('?') || /^\d+[\).\:]/.test(text) || /^Question \d+/.test(text)) {
            return child;
          }
        }
      }
    }
    
    parent = parent.parentElement;
    depth++;
  }
  
  return null;
}

async function analyzeQuestion(questionData, apiKey) {
  const { text, choices, inputElement } = questionData;

  const result = await chrome.storage.sync.get(['provider']);
  const provider = result.provider || 'groq';

  // Build prompt based on question type
  let prompt;
  
  if (choices && choices.length > 0) {
    // Multiple choice - simple and direct
    prompt = `${text}

Group of answer choices:
${choices.map(c => c.text).join('\n')}

Respond with only:
Answer: [the exact text of the correct answer choice]
Explanation: [correct answer] because [brief reason]`;
  } else {
    // Fill-in question
    prompt = `${text}

Answer: [your answer]
Explanation: [brief reason]`;
  }
  
  console.log("=== QUESTION DEBUG ===");
  console.log("Question text:", text);
  console.log("Choices:", choices?.map((c, i) => `${String.fromCharCode(65 + i)}: ${c.text}`));
  console.log("Full prompt:", prompt);

  try {
    let response;

    if (provider === 'groq') {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'user', content: prompt }
          ],
          temperature: 0.05,
          max_tokens: 200
        })
      });
    } else {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'user', content: prompt }
          ],
          temperature: 0.05,
          max_tokens: 200
        })
      });
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`API error: ${response.status} - ${err.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();

    let aiResponse =
      data.choices?.[0]?.message?.content ||
      data.choices?.[0]?.message?.reasoning ||
      '';

    aiResponse = aiResponse.trim();
    console.log("AI raw response:", aiResponse);
    console.log("Full API response:", JSON.stringify(data, null, 2));

    if (!aiResponse) {
      console.error("Empty response! Full data:", data);
      addError(questionData.element, "⚠️ AI returned an empty response. Try a different model.");
      return;
    }

    // Parse answer + explanation
    const answerMatch = aiResponse.match(/Answer:\s*(.+?)(?:\n|Explanation:|$)/is);
    const explanationMatch = aiResponse.match(/Explanation:\s*(.+)/is);
    
    if (choices && choices.length > 0) {
      // Multiple choice - match the answer text to find the right choice
      if (answerMatch) {
        const answerText = answerMatch[1].trim();
        
        console.log(`AI answer text: "${answerText}"`);
        
        // Find which choice matches the answer (fuzzy matching)
        let selectedChoice = null;
        let bestMatchIndex = -1;
        
        // Try exact match first
        for (let i = 0; i < choices.length; i++) {
          if (choices[i].text.trim() === answerText) {
            selectedChoice = choices[i];
            bestMatchIndex = i;
            break;
          }
        }
        
        // If no exact match, try partial matching
        if (!selectedChoice) {
          for (let i = 0; i < choices.length; i++) {
            const choiceText = choices[i].text.trim().toLowerCase();
            const answerLower = answerText.toLowerCase();
            
            // Check if answer contains most of the choice text or vice versa
            if (choiceText.includes(answerLower) || answerLower.includes(choiceText)) {
              selectedChoice = choices[i];
              bestMatchIndex = i;
              break;
            }
          }
        }
        
        if (selectedChoice) {
          console.log(`Matched to choice ${bestMatchIndex}: ${selectedChoice.text}`);
          highlightChoice(selectedChoice);
          
          const explanation = explanationMatch ? explanationMatch[1].trim() : answerText + ' because it is the correct answer.';
          addExplanation(questionData.element, explanation);
        } else {
          addError(questionData.element, `⚠️ Could not match answer: "${answerText}"`);
        }
      } else {
        addError(questionData.element, `⚠️ Could not parse answer from: "${aiResponse}"`);
      }
    } else if (inputElement) {
      // Fill-in question
      const answerText = answerMatch ? answerMatch[1].trim() : aiResponse.split('\n')[0];
      const explanation = explanationMatch ? explanationMatch[1].trim() : '';
      
      highlightFillIn(questionData.element, answerText, inputElement);
      if (explanation) {
        addExplanation(questionData.element, explanation);
      }
    }

  } catch (error) {
    console.error('Error calling AI API:', error);
    addError(questionData.element, `⚠️ ${error.message}`);
  }
}

function highlightChoice(choice) {
  // Don't modify the element's style to avoid blocking clicks
  choice.element.setAttribute('data-ai-highlighted', 'true');

  // DO NOT auto-check the radio button - let user click it themselves
  // Removed: choice.inputElement.checked = true;
  // Removed: choice.inputElement.setAttribute('data-ai-checked', 'true');

  // Create arrow indicator that points to the answer
  const arrow = document.createElement('div');
  arrow.className = 'ai-answer-arrow';
  arrow.innerHTML = '➜';
  arrow.setAttribute('data-ai-checkmark', 'true');
  arrow.style.cssText = `
    position: absolute;
    left: -40px;
    top: 50%;
    transform: translateY(-50%);
    color: #4CAF50;
    font-size: 2em;
    font-weight: bold;
    animation: pulse 2s infinite, slide 1s ease-out;
    pointer-events: none;
    z-index: 1000;
  `;
  
  // Make sure parent has position relative
  choice.element.style.position = 'relative';
  choice.element.appendChild(arrow);
  
  // Add a subtle background glow without affecting layout
  const glow = document.createElement('div');
  glow.className = 'ai-answer-glow';
  glow.setAttribute('data-ai-checkmark', 'true');
  glow.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(76, 175, 80, 0.1);
    border-radius: 8px;
    pointer-events: none;
    z-index: -1;
    animation: pulse-glow 2s infinite;
  `;
  
  choice.element.appendChild(glow);
}

function highlightFillIn(element, answer, inputElement) {
  const overlay = document.createElement('div');
  overlay.className = 'ai-answer-overlay';
  overlay.innerHTML = `<strong>Answer:</strong> ${answer}`;
  overlay.style.cssText = `
    position: relative;
    background: rgba(76, 175, 80, 0.2);
    border-left: 4px solid #4CAF50;
    padding: 10px;
    margin: 10px 0;
    border-radius: 4px;
    font-weight: 500;
  `;
  
  element.parentNode.insertBefore(overlay, element.nextSibling);
  
  if (inputElement) {
    inputElement.value = answer;
    inputElement.style.border = '2px solid #4CAF50';
  }
}

function addExplanation(element, explanation) {
  // Check if an explanation already exists for this element
  let nextSibling = element.nextSibling;
  while (nextSibling) {
    if (nextSibling.classList && nextSibling.classList.contains('ai-explanation')) {
      console.log('Explanation already exists, skipping duplicate');
      return; // Don't add duplicate
    }
    nextSibling = nextSibling.nextSibling;
  }
  
  const explanationBox = document.createElement('div');
  explanationBox.className = 'ai-explanation';
  explanationBox.innerHTML = `
    <strong style="color: #2196F3;">💡 Explanation:</strong><br>
    ${explanation}
  `;
  explanationBox.style.cssText = `
    position: relative;
    background: #f0f7ff;
    border-left: 4px solid #2196F3;
    padding: 12px;
    margin: 10px 0;
    border-radius: 4px;
    font-size: 0.95em;
    line-height: 1.5;
  `;
  
  element.parentNode.insertBefore(explanationBox, element.nextSibling);
}

function addError(element, message) {
  const errorBox = document.createElement('div');
  errorBox.className = 'ai-error-box';
  errorBox.innerHTML = `⚠️ ${message}`;
  errorBox.style.cssText = `
    background: #ffebee;
    color: #c62828;
    padding: 8px;
    margin: 5px 0;
    border-radius: 4px;
  `;
  element.parentNode.insertBefore(errorBox, element.nextSibling);
}

function showLoadingIndicator(message) {
  const loading = document.createElement('div');
  loading.id = 'ai-loading-indicator';
  loading.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <div class="spinner"></div>
      <span>${message}</span>
    </div>
  `;
  loading.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: white;
    border: 2px solid #4CAF50;
    border-radius: 8px;
    padding: 15px 20px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 999999;
    font-family: Arial, sans-serif;
  `;
  document.body.appendChild(loading);
}

function updateLoadingIndicator(message) {
  const loading = document.getElementById('ai-loading-indicator');
  if (loading) {
    loading.querySelector('span').textContent = message;
  }
}

function hideLoadingIndicator() {
  const loading = document.getElementById('ai-loading-indicator');
  if (loading) {
    loading.remove();
  }
}

function showCompletionMessage(message) {
  const completion = document.createElement('div');
  completion.innerHTML = `✓ ${message}`;
  completion.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #4CAF50;
    color: white;
    border-radius: 8px;
    padding: 15px 20px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 999999;
    font-family: Arial, sans-serif;
    font-weight: bold;
  `;
  document.body.appendChild(completion);
  
  setTimeout(() => {
    completion.style.transition = 'opacity 0.5s';
    completion.style.opacity = '0';
    setTimeout(() => completion.remove(), 500);
  }, 3000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}