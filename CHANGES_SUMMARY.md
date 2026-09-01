# AI Playground Admin Area - Changes Summary

## Date: 2026-09-01

## Overview
Updated the AI Playground in the admin area to support new models, chat history management, and log deletion capabilities.

## Changes Made

### 1. Updated Models (src/lib/groq.js)
**Changed the available models to:**
- `openai/gpt-oss-20b` - OpenAI GPT-OSS 20B
- `openai/gpt-oss-120b` - OpenAI GPT-OSS 120B
- `qwen/qwen3.8-27b` - Qwen 3.8 27B
- `qwen/qwen3.6-27b` - Qwen 3.6 27B
- `llama-3.3-70b-versatile` - Llama 3.3 70B (legacy)
- `llama-3.1-8b-instant` - Llama 3.1 8B Instant (legacy)
- `llama3-70b-8192` - Llama 3 70B 8k (legacy)
- `mixtral-8x7b-32768` - Mixtral 8×7B (legacy)

**Updated fallbacks to include new models.**

### 2. Added Chat Session Management (src/db.js)
**New database tables:**
- `ai_chat_sessions` - Stores chat session metadata (title, model, user_id, active status, archived status)
- `ai_chat_messages` - Stores individual messages within each chat session

**Indexes created for performance:**
- `idx_ai_chat_user` - For querying sessions by user
- `idx_ai_chat_active` - For finding active sessions
- `idx_ai_chat_archived` - For finding archived sessions
- `idx_ai_chat_msgs_session` - For querying messages by session

### 3. Extended AI Library (src/lib/ai.js)
**New functions added:**
- `createChatSession(userId, title, model)` - Create a new chat session
- `getChatSessions(userId, includeArchived)` - Get all chat sessions for a user
- `getChatSession(sessionId)` - Get a specific session
- `getChatMessages(sessionId, limit)` - Get messages for a session
- `addChatMessage(sessionId, role, content)` - Add a message to a session
- `deleteChatSession(sessionId)` - Delete a chat session
- `archiveChatSession(sessionId)` - Archive a chat session
- `unarchiveChatSession(sessionId)` - Unarchive a chat session
- `purgeOldArchivedChats(days)` - Purge archived chats older than specified days (default 30)
- `setActiveSession(sessionId)` - Set a session as active
- `deleteAuditLogEntry(id)` - Delete an audit log entry
- `deleteModerationLogEntry(id)` - Delete a moderation log entry

### 4. Added New API Routes (src/routes/adminai.js)
**Chat Session Management:**
- `POST /admin3119Musa/ai/chat/sessions` - List chat sessions
- `POST /admin3119Musa/ai/chat/session/create` - Create a new chat session
- `POST /admin3119Musa/ai/chat/session/:id/messages` - Get messages for a session
- `POST /admin3119Musa/ai/chat/session/:id/delete` - Delete a chat session
- `POST /admin3119Musa/ai/chat/session/:id/archive` - Archive a chat session
- `POST /admin3119Musa/ai/chat/session/:id/unarchive` - Unarchive a chat session
- `POST /admin3119Musa/ai/chat/session/:id/activate` - Activate a chat session
- `POST /admin3119Musa/ai/chat/purge-old` - Purge old archived chats

**Log Management:**
- `POST /admin3119Musa/ai/audit/:id/delete` - Delete an audit log entry
- `POST /admin3119Musa/ai/moderation/:id/delete` - Delete a moderation log entry

### 5. Enhanced UI (views/admin/ai.ejs)

#### Chat Interface Enhancements:
- **New Chat Button** - Start a new chat session at any time
- **Chat History Sidebar** - Toggleable sidebar showing all chat sessions
- **Session Management** - For each chat session:
  - View title, model, and last updated time
  - Activate to continue a previous chat
  - Archive to hide from main list (retains for 30 days)
  - Unarchive to restore from archived list
  - Delete to permanently remove
  - Visual indicators for active and archived sessions
- **Show/Hide Archived Chats** - Toggle to view archived sessions
- **Purge Old Chats** - One-click purge of chats archived >30 days
- **Refresh Chat History** - Reload the chat session list

#### Log Management Enhancements:
- **Audit Log** - Added deletion capability:
  - Delete button on each audit log entry
  - Confirmation dialog before deletion
  - Maintains all existing functionality

- **Moderation Log** - Added deletion capability:
  - Delete button on each moderation log entry
  - Confirmation dialog before deletion
  - Maintains all existing functionality

- **Refresh Buttons** - Added refresh buttons for both logs
- **Load More Buttons** - Added "Load More" buttons for pagination (framework in place)

#### Styling:
- Added CSS styles for chat history sidebar
- Added styles for chat history items (active, archived, hover states)
- Added styles for action buttons
- Added styles for log tables with scrolling
- Maintained existing design language

## Features Implemented

### ✅ Model Changes
- All four requested models added: openai/gpt-oss-20b, openai/gpt-oss-120b, qwen/qwen3.8-27b, qwen/qwen3.6-27b
- Legacy models retained for backward compatibility
- Models appear in the dropdown selector in Settings

### ✅ New Chat Functionality
- "New Chat" button creates a fresh chat session
- Current conversation is preserved when starting new chat
- Chat sessions are stored with metadata (title, model, timestamps)

### ✅ Delete Past Chats
- Delete individual chat sessions with confirmation
- Permanent deletion with no recovery

### ✅ Archive Past Chats for 30 Days
- Archive chats to hide from main list
- Archived chats retained for 30 days
- Unarchive capability to restore chats
- Automatic purge of chats archived >30 days
- Manual purge button for old archived chats

### ✅ Scrolling for Audit and Moderation Logs
- Log tables have max-height and overflow-y: auto
- Scrollable containers for both audit and moderation logs
- Maintains all existing log display functionality

### ✅ Deletion of Audit and Moderation Logs
- Delete button on each log entry
- Confirmation dialog before deletion
- Immediate removal from UI
- Server-side deletion from database

### ✅ All Existing Functionality Maintained
- Listing generator works as before
- Admin assistant works as before
- Settings configuration works as before
- Auto-moderation works as before
- All existing features preserved

## Files Modified

1. `src/lib/groq.js` - Updated MODELS array and FALLBACKS
2. `src/db.js` - Added ai_chat_sessions and ai_chat_messages tables
3. `src/lib/ai.js` - Added chat session management functions
4. `src/routes/adminai.js` - Added new API routes for chat and log management
5. `views/admin/ai.ejs` - Enhanced UI with chat history, new buttons, and log management

## Total Changes
- 5 files changed
- 703 insertions(+)
- 9 deletions(-)

## Backward Compatibility
All changes are backward compatible:
- Legacy models remain in the list
- Existing database schema unchanged (new tables added)
- Existing API endpoints unchanged (new endpoints added)
- Existing UI elements preserved (new elements added)

## Security Considerations
- Chat sessions are user-scoped (user_id stored with each session)
- Deletion actions require confirmation
- All actions validate user ownership before execution
- API endpoints protected by existing admin middleware
