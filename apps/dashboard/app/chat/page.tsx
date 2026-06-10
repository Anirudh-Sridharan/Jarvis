/**
 * Chat page — feature 2.
 * Full-screen chat backed by the core service SSE stream.
 * The Chat component is preserved exactly from Phase 1.
 */

import Chat from "@/app/components/Chat";

export default function ChatPage() {
  return (
    <div className="page-chat">
      <Chat />
    </div>
  );
}
