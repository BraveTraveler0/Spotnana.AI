import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import './App.css';

interface ChatMessage {
  id: string;
  prompt: string;
  response: string;
  timestamp: number;
}

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [currentResponse, setCurrentResponse] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string;

  useEffect(() => {
    const savedHistory = localStorage.getItem('spotana-chat-history');
    if (savedHistory) {
      try {
        setChatHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error('Error loading chat history:', e);
      }
    }
  }, []);

  useEffect(() => {
    if (chatHistory.length > 0) {
      localStorage.setItem('spotana-chat-history', JSON.stringify(chatHistory));
    }
  }, [chatHistory]);

  const handleSubmit = async () => {
    if (!prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }

    if (!apiKey) {
      setError('OpenAI API key not found. Add VITE_OPENAI_API_KEY to your .env file.');
      return;
    }

    setIsLoading(true);
    setError('');
    setCurrentResponse('');

    try {
      const response = await fetch('/api/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful travel assistant. Provide informative, friendly, and practical travel advice.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.7,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to get response from AI');
      }

      const data = await response.json();
      const aiResponse = data.choices[0].message.content;

      const newMessage: ChatMessage = {
        id: Date.now().toString(),
        prompt,
        response: aiResponse,
        timestamp: Date.now(),
      };

      setChatHistory(prev => [newMessage, ...prev]);
      setCurrentResponse(aiResponse);
      setPrompt('');
    } catch (err) {
      console.error('Fetch error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setPrompt('');
    setCurrentResponse('');
    setError('');
  };

  const handleClearHistory = () => {
    setChatHistory([]);
    localStorage.removeItem('spotana-chat-history');
    setCurrentResponse('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="app-container">
      <div className="main-content">

        {/* Left Section — sticky input + history */}
        <div className="left-section">
          <motion.h1
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
            className="app-title"
          >
            SPOTANA.AI
          </motion.h1>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' }}
            className="app-subtitle"
          >
            <p>Ask me anything about travel and I'll answer.</p>
            <p>Where would you like to go next?</p>
          </motion.div>

          <motion.textarea
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5, ease: 'easeOut' }}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Start Planning your next trip"
            className="prompt-input"
          />

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="error-message"
            >
              <p>{error}</p>
            </motion.div>
          )}

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.7, ease: 'easeOut' }}
            className="button-group"
          >
            <button onClick={handleClear} disabled={isLoading || !prompt.trim()} className="button button-clear">
              Clear
            </button>
            <button
              onClick={handleSubmit}
              disabled={isLoading || !prompt.trim()}
              className="button button-submit"
            >
              {isLoading ? (
                <>
                  <Loader2 className="spinner" />
                  <span>Loading...</span>
                </>
              ) : (
                'Submit'
              )}
            </button>
          </motion.div>

          {/* Past conversations — small, understated */}
          {chatHistory.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
              className="left-history"
            >
              <div className="left-history-header">
                <span className="left-history-title">Past</span>
                <button className="left-history-clear" onClick={handleClearHistory}>
                  Clear
                </button>
              </div>

              {chatHistory.map((msg) => (
                <div key={msg.id} className="left-history-item">
                  <p className="left-history-prompt">{msg.prompt}</p>
                  <p className="left-history-time">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              ))}
            </motion.div>
          )}

          <footer className="footer">
            <p>© 2026 Spotana.AI · <span className="footer-link">Privacy Policy</span> · <span className="footer-link">Terms of Use</span></p>
            <p className="footer-sub">Built by Darrien Carter</p>
          </footer>
        </div>

        {/* Divider */}
        <div className="divider" />

        {/* Right Section — scrollable response */}
        <div className="right-section">
          {!currentResponse && !isLoading ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1, delay: 1 }}
              className="empty-state"
            >
              <p>Your response will appear here</p>
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="response-box"
            >
              <h2 className="box-title">AI Response</h2>
              {isLoading ? (
                <div className="loading-state">
                  <Loader2 className="spinner-large" />
                  <p>Thinking...</p>
                </div>
              ) : (
                <p className="response-text">{currentResponse}</p>
              )}
            </motion.div>
          )}
        </div>

      </div>
    </div>
  );
}
