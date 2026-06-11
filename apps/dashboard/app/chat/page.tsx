/**
 * Chat page — feature 2.
 * Console-panel shell around the Chat component (components/Chat.tsx), which
 * talks to the core service's /chat SSE stream directly from the browser.
 */

import Chat from "@/app/components/Chat";

export default function ChatPage() {
  return (
    <div className="page-chat">
      <div className="chat-console">
        <div className="chat-console__head">
          <div className="chat-console__title">Chat Console</div>
          <div className="chat-console__meta">Direct link · Streaming</div>
        </div>
        <Chat />
      </div>
    </div>
  );
}
