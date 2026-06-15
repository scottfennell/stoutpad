# Stout Project Brief & Product Requirements Document (PRD)

## 1. Product Overview
Stout is a high-fidelity, interlinked note-taking application designed for power users who value portability, privacy, and technical rigor. It combines the flexibility of a rich markdown editor with the organizational power of a hierarchical file browser, all built on standard open technologies (Markdown, Git, and Vector Databases).

### Core Value Proposition
*   **Standards-Based:** Uses open formats (Markdown) to ensure no vendor lock-in.
*   **Technical Rigor:** Integrated Git versioning for every change.
*   **Semantic Intelligence:** Built-in vector database for high-relevance search across interlinked notes.
*   **Refined Aesthetic:** A professional "Technical Umber" visual language that balances focus with personality.

---

## 2. Target Audience
*   Software Engineers and Technical Architects.
*   Product Managers and Researchers.
*   Knowledge workers requiring a "second brain" with clear organization and deep search capabilities.

---

## 3. Visual Identity & Design System
The application uses the **Technical Umber** design system, characterized by:
*   **Palette:** Rich dark brown backgrounds (#111415) acting as "gutters" between distinct UI panels.
*   **Hierarchy:** Subtle contrast in surface fills to distinguish between navigation, content, and utility regions.
*   **Accents:** Vibrant light blue accents (#93c5fd) applied exclusively to icons and primary functional elements to provide "pop" without distraction.
*   **Typography:** Technical, highly legible fonts (Geist) with clear heading hierarchy and monospace support for code blocks.
*   **Geometry:** Rounded corners on panels contrasting with a flat, line-based structural aesthetic.

---

## 4. Key Functional Requirements

### 4.1 Navigation & Organization
*   **Hierarchical File Tree:** A persistent sidebar browser that organizes notes into nested folders (e.g., Projects, Personal, Archives).
*   **Search-Centric Flow:** A dedicated search view leveraging a vector database for semantic discovery beyond simple keyword matching.
*   **Mobile Adaptability:** A focused, single-column mobile layout that preserves the core editing experience and brand identity.

### 4.2 Workspace & Editor
*   **Mobile-Style Header:** Desktop headers feature a centralized title with tags listed as chips immediately below, removing breadcrumbs to maximize focus.
*   **Panel-Based Layout:** A three-column architecture:
    *   **Left:** Navigation/File Tree.
    *   **Center:** Markdown Editor (Main Workspace).
    *   **Right:** Contextual Utilities (Calendar, Table of Contents, Metadata).
*   **Rich Markdown Support:** Real-time rendering of markdown syntax, checkboxes, and inter-document links ([[Note Name]]).

### 4.3 Technical Infrastructure
*   **Git Integration:** Automatic commits for version history and cross-device synchronization.
*   **Local-First Storage:** Notes are stored as standard files on the local file system.
*   **Vector Search:** Indexing of all markdown content for semantic search results.

---

## 5. Screen Inventory (Current)
1.  **Main Workspace:** The primary editor view with file tree, mobile-style header, and utility panels.
2.  **Search Results:** A dedicated view for semantic discovery with advanced filtering.
3.  **Settings:** Configuration for sync (Git), appearance, and technical defaults.
4.  **Mobile Workspace:** A responsive adaptation for on-the-go note access.

---

## 6. Success Metrics
*   **User Retention:** High daily active usage due to fast, focused workflow.
*   **Search Efficacy:** High "click-through" rate on top 3 semantic search results.
*   **Sync Reliability:** Zero data loss or merge conflicts during Git-based synchronization.