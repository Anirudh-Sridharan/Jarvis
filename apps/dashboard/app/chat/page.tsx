/**
 * Chat page — feature 2.
 * Page shell around the Chat component (components/Chat.tsx), which talks to
 * the core service's /chat SSE stream directly from the browser.
 */

import Chat from "@/app/components/Chat";

export default function ChatPage() {
  return (
    <div className="page-chat">
      <Chat />
    </div>
  );
}
