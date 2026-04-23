"use strict";
var obsidian = require("obsidian");

const VIEW_TYPE = "plotgrid-view";
const RIBBON_ICON = "layout-grid";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseActNum(act) {
    const raw = String(act ?? "");
    if (raw === "") return 0;
    const m = raw.match(/-?\d+/);
    return m ? Number(m[0]) : 0;
}

function contrastColor(color) {
    if (!color) return "var(--text-normal)";
    try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return r * 0.299 + g * 0.587 + b * 0.114 > 140 ? "#000" : "#fff";
    } catch {
        return "var(--text-normal)";
    }
}

function normalizeColor(c) {
    if (!c) return null;
    const s = String(c).trim();
    return /^(#[\da-f]{3,8}|(rgb|hsl)a?\(|[a-z]+$)/i.test(s) ? s : null;
}

// ─── View ─────────────────────────────────────────────────────────────────────

class PlotGridView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.dragSrcPath = null;
        this._dropping = false;
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return "PlotGrid"; }
    getIcon() { return RIBBON_ICON; }

    async onOpen() {
        await this.refresh();
    }

    async refresh() {
        const container = this.containerEl.children[1];
        container.empty();
        container.style.cssText = "padding:16px;overflow:auto;height:100%;box-sizing:border-box;";

        // Header + refresh button
        const header = container.createDiv();
        header.style.cssText = "display:flex;align-items:center;gap:12px;margin-bottom:16px;";
        header.createEl("h3", { text: "PlotGrid", attr: { style: "margin:0;" } });
        const refreshBtn = header.createEl("button", { text: "↻ Refresh" });
        refreshBtn.style.cssText = "cursor:pointer;padding:2px 10px;border-radius:4px;font-size:12px;";
        refreshBtn.onclick = () => this.refresh();

        const books = this.plugin.settings.books || [];

        if (books.length === 0) {
            container.createEl("p", {
                text: "No books configured. Go to Settings → PlotGrid and add a book.",
            });
            return;
        }

        // Horizontal wrapper for all books side by side
        const booksRow = container.createDiv();
        booksRow.style.cssText =
            "display:flex;gap:32px;overflow-x:auto;align-items:flex-start;padding-bottom:16px;";

        for (const book of books) {
            const rootPaths = this.parseRoots(book.root);
            if (rootPaths.length === 0) continue;

            const bookCol = booksRow.createDiv();
            bookCol.style.cssText =
                "flex:0 0 auto;min-width:300px;max-width:1100px;" +
                "border:1px solid var(--background-modifier-border);border-radius:8px;" +
                "padding:12px;background:var(--background-primary);";

            // Book title
            const titleEl = bookCol.createEl("h4", { text: book.title || "Untitled Book" });
            titleEl.style.cssText =
                "margin:0 0 4px 0;padding-bottom:6px;" +
                "border-bottom:2px solid var(--color-accent);color:var(--text-normal);font-size:15px;";

            // Scanning info
            const pathInfo = bookCol.createEl("p", { text: "Scanning: " + rootPaths.join(", ") });
            pathInfo.style.cssText = "font-size:11px;color:var(--text-muted);margin-bottom:8px;";

            const rows = await this.loadRows(rootPaths);

            if (rows.length === 0) {
                const s = this._lastSkipped || {};
                bookCol.createEl("p", {
                    text: `No notes found. Skipped: ${s.noContext || 0} outside path, ${s.noFm || 0} no frontmatter, ${s.noChapter || 0} no chapter, ${s.noAct || 0} no act.`,
                });
                continue;
            }

            // Build sorted unique act+chapter pairs
            const pairMap = new Map();
            for (const r of rows) {
                const key = `${r.actNum}|${r.chapter}`;
                if (!pairMap.has(key)) {
                    pairMap.set(key, { actNum: r.actNum, actRaw: r.actRaw, chapter: r.chapter });
                }
            }
            const pairs = [...pairMap.values()].sort((a, b) =>
                a.actNum !== b.actNum ? a.actNum - b.actNum : a.chapter - b.chapter
            );

            // Unique contexts (columns / threads)
            const contexts = [...new Set(rows.map((r) => r.context))].sort();

            // Grid lookup
            const grid = new Map();
            for (const r of rows) {
                const key = `${r.actNum}|${r.chapter}|${r.context}`;
                if (!grid.has(key)) grid.set(key, []);
                grid.get(key).push(r);
            }

            this.renderGrid(bookCol, pairs, contexts, grid, rootPaths);
        }
    }

    parseRoots(rootStr) {
        const setting = (rootStr || "").trim();
        if (!setting) return [];
        return setting.split("\n").map(r => r.trim().replace(/\/+$/, "")).filter(r => r.length > 0);
    }

    renderGrid(container, pairs, contexts, grid, rootPaths) {
        // New cell drop zone
        const newZone = container.createDiv();
        newZone.style.cssText =
            "border:2px dashed var(--color-accent);border-radius:8px;padding:10px 16px;" +
            "margin-bottom:12px;font-size:13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;";

        const zoneLabel = newZone.createEl("span", { text: "➕ New cell:" });
        zoneLabel.style.cssText = "color:var(--color-accent);font-weight:600;white-space:nowrap;";

        const makeInput = (placeholder) => {
            const inp = newZone.createEl("input");
            inp.type = "text";
            inp.placeholder = placeholder;
            inp.style.cssText =
                "width:90px;padding:4px 8px;border-radius:4px;font-size:12px;" +
                "border:1px solid var(--background-modifier-border);" +
                "background:var(--background-secondary);color:var(--text-normal);";
            inp.addEventListener("mousedown", e => e.stopPropagation());
            inp.addEventListener("dragover", e => e.stopPropagation());
            return inp;
        };

        const actInput = makeInput("Act (e.g. -1)");
        const chInput = makeInput("Chapter (e.g. 0)");

        const dropTarget = newZone.createEl("span", { text: "← drag card here" });
        dropTarget.style.cssText =
            "color:var(--color-accent);opacity:0.7;font-style:italic;white-space:nowrap;";

        this.wireNewCellDropZone(newZone, actInput, chInput);

        // Table
        const tableWrap = container.createDiv();
        tableWrap.style.cssText = "overflow-x:auto;";
        const table = tableWrap.createEl("table");
        table.style.cssText = "border-collapse:collapse;min-width:100%;font-size:13px;";

        // Header
        const thead = table.createEl("thead");
        const headerRow = thead.createEl("tr");
        for (const col of ["Act", "Chapter", ...contexts]) {
            const th = headerRow.createEl("th", { text: col });
            th.style.cssText =
                "padding:8px 12px;text-align:left;border-bottom:2px solid var(--background-modifier-border);" +
                "white-space:nowrap;font-weight:600;color:var(--text-muted);";
        }

        // Body
        const tbody = table.createEl("tbody");
        let prevActNum = null;
        for (const pair of pairs) {
            // Insert a phantom row at each act boundary (but not before the very first row)
            if (prevActNum !== null && pair.actNum !== prevActNum) {
                this.renderPhantomRow(tbody, contexts, rootPaths, { isBoundary: true });
            }
            prevActNum = pair.actNum;

            const tr = tbody.createEl("tr");
            tr.style.cssText = "border-bottom:1px solid var(--background-modifier-border);";

            const actTd = tr.createEl("td", {
                text: pair.actRaw !== "" ? String(pair.actRaw) : String(pair.actNum),
            });
            actTd.style.cssText = "padding:6px 12px;white-space:nowrap;color:var(--text-muted);font-weight:500;";

            const chTd = tr.createEl("td", { text: String(pair.chapter) });
            chTd.style.cssText = "padding:6px 12px;white-space:nowrap;color:var(--text-muted);";

            for (const ctx of contexts) {
                const key = `${pair.actNum}|${pair.chapter}|${ctx}`;
                const files = grid.get(key) || [];
                const td = tr.createEl("td");
                td.style.cssText = "padding:6px 8px;vertical-align:top;min-width:140px;cursor:pointer;";
                this.wireDropTarget(td, pair.actNum, pair.actRaw, pair.chapter, ctx, rootPaths);

                if (files.length === 0) {
                    const em = td.createEl("span", { text: "—" });
                    em.style.color = "var(--text-faint)";
                } else {
                    for (const row of files) {
                        this.renderCard(td, row);
                    }
                }
            }
        }

        // ── Phantom row ───────────────────────────────────────────────────────
        this.renderPhantomRow(tbody, contexts, rootPaths);
    }

    /**
     * Renders a dashed "phantom" row.
     * Used both at act boundaries (isBoundary: true) and at the bottom of the table.
     * Each cell accepts card drops; boundary rows pre-fill Act/Ch from neighbours,
     * bottom row shows explicit inputs.
     */
    renderPhantomRow(tbody, contexts, rootPaths, { isBoundary = false } = {}) {
        const tr = tbody.createEl("tr");
        tr.style.cssText =
            (isBoundary
                ? "border-top:2px solid var(--background-modifier-border);border-bottom:2px solid var(--background-modifier-border);"
                : "border-top:2px dashed var(--background-modifier-border);") +
            "opacity:0.55;transition:opacity 0.15s;";

        // Highlight the row while something is dragged over any part of it
        tr.addEventListener("dragenter", () => { tr.style.opacity = "1"; });
        tr.addEventListener("dragleave", (e) => {
            if (!tr.contains(e.relatedTarget)) tr.style.opacity = "0.55";
        });
        tr.addEventListener("drop", () => { tr.style.opacity = "0.55"; });

        // Helper: small inline input for the phantom row
        const makePhantomInput = (td, placeholder, width = "62px") => {
            const inp = td.createEl("input");
            inp.type = "text";
            inp.placeholder = placeholder;
            inp.style.cssText =
                `width:${width};padding:2px 5px;border-radius:3px;font-size:11px;` +
                "border:1px dashed var(--background-modifier-border);" +
                "background:transparent;color:var(--text-muted);";
            inp.addEventListener("mousedown", e => e.stopPropagation());
            inp.addEventListener("dragover", e => e.stopPropagation());
            return inp;
        };

        // Act cell
        const actTd = tr.createEl("td");
        actTd.style.cssText = "padding:4px 8px;white-space:nowrap;vertical-align:middle;";
        if (isBoundary) {
            const lbl = actTd.createEl("span", { text: "—" });
            lbl.style.cssText = "font-size:11px;color:var(--text-faint);font-style:italic;";
        }
        const actInput = isBoundary ? null : makePhantomInput(actTd, "Act…");

        // Chapter cell
        const chTd = tr.createEl("td");
        chTd.style.cssText = "padding:4px 8px;white-space:nowrap;vertical-align:middle;";
        const chInput = isBoundary ? null : makePhantomInput(chTd, "Ch…");

        // One drop-target cell per context column
        for (const ctx of contexts) {
            const td = tr.createEl("td");
            td.style.cssText =
                "padding:4px 8px;vertical-align:middle;min-width:140px;" +
                "border-left:1px dashed var(--background-modifier-border);";

            const hint = td.createEl("span", { text: "drop here" });
            hint.style.cssText =
                "font-size:11px;color:var(--text-faint);font-style:italic;pointer-events:none;";

            // Wire drag-and-drop
            td.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.stopPropagation();
                td.style.outline = "2px solid var(--color-accent)";
                td.style.borderRadius = "4px";
            });
            td.addEventListener("dragleave", (e) => {
                if (!td.contains(e.relatedTarget)) {
                    td.style.outline = "";
                }
            });
            td.addEventListener("drop", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                td.style.outline = "";

                if (this._dropping) return;

                const dtPath = (e.dataTransfer?.getData("text/plain") || "").trim();
                const path = dtPath || this.dragSrcPath;
                if (!path) return;

                let actRaw, chRaw;
                if (isBoundary) {
                    // No inputs on boundary rows — prompt inline
                    actRaw = (await this.promptValue("Act for new position (e.g. 2):") ?? "").trim();
                    if (!actRaw) return;
                    chRaw = (await this.promptValue("Chapter for new position (e.g. 1):") ?? "").trim();
                    if (!chRaw) return;
                } else {
                    actRaw = actInput.value.trim();
                    chRaw = chInput.value.trim();
                    if (!actRaw || !chRaw) {
                        new obsidian.Notice("Fill in the Act and Chapter fields in the phantom row before dropping.");
                        return;
                    }
                }

                const chapter = Number(chRaw);
                if (!Number.isFinite(chapter)) {
                    new obsidian.Notice("Invalid chapter number.");
                    return;
                }

                this._dropping = true;
                const actNum = parseActNum(actRaw);
                await this.updateNoteFrontmatter(path, actNum, actRaw, chapter);
                if (!isBoundary) { actInput.value = ""; chInput.value = ""; }
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.refresh();
                this._dropping = false;
            });

            // Double-click to create a new note in this context column
            td.addEventListener("dblclick", async () => {
                let actRaw, chRaw;
                if (isBoundary) {
                    actRaw = (await this.promptValue("Act (e.g. 2):") ?? "").trim();
                    if (!actRaw) return;
                    chRaw = (await this.promptValue("Chapter (e.g. 1):") ?? "").trim();
                    if (!chRaw) return;
                } else {
                    actRaw = actInput.value.trim();
                    chRaw = chInput.value.trim();
                    if (!actRaw || !chRaw) {
                        new obsidian.Notice("Fill in Act and Chapter first.");
                        return;
                    }
                }
                const chapter = Number(chRaw);
                if (!Number.isFinite(chapter)) {
                    new obsidian.Notice("Invalid chapter number.");
                    return;
                }
                const actNum = parseActNum(actRaw);
                await this.createNoteInCell(actNum, actRaw, chapter, ctx, rootPaths);
            });
        }
    }

    renderCard(parent, row) {
        const card = parent.createDiv();
        const bg = row.color || "var(--background-secondary)";
        const fg = row.color ? contrastColor(row.color) : "var(--text-normal)";

        card.style.cssText =
            `background:${bg};color:${fg};padding:5px 8px;border-radius:6px;` +
            `margin-bottom:3px;cursor:grab;user-select:none;font-size:12px;` +
            `border:1px solid rgba(128,128,128,0.2);transition:opacity 0.15s;`;

        const link = card.createEl("a", { text: row.file.basename, cls: "internal-link" });
        link.style.cssText = `color:${fg};text-decoration:none;font-weight:500;`;
        link.setAttribute("data-href", row.file.path);
        link.onclick = (e) => {
            e.preventDefault();
            this.app.workspace.openLinkText(row.file.path, "", false);
        };

        if (row.summary) {
            const sum = card.createEl("div", { text: String(row.summary) });
            sum.style.cssText = "font-size:11px;opacity:0.8;margin-top:2px;";
        }

        card.draggable = true;
        card.ondragstart = (e) => {
            this.dragSrcPath = row.file.path;
            e.dataTransfer?.setData("text/plain", row.file.path);
            requestAnimationFrame(() => {
                card.style.opacity = "0.4";
                Array.from(card.children).forEach(c => c.style.pointerEvents = "none");
            });
        };
        card.ondragend = () => {
            card.style.opacity = "1";
            Array.from(card.children).forEach(c => c.style.pointerEvents = "");
            setTimeout(() => { this.dragSrcPath = null; }, 500);
        };
    }

    wireDropTarget(td, actNum, actRaw, chapter, ctx, rootPaths) {
        td.addEventListener("dblclick", async () => {
            await this.createNoteInCell(actNum, actRaw, chapter, ctx, rootPaths);
        });
        td.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.stopPropagation();
            td.style.outline = "2px solid var(--color-accent)";
        });
        td.addEventListener("dragleave", (e) => {
            if (!td.contains(e.relatedTarget)) {
                td.style.outline = "";
            }
        });
        td.addEventListener("drop", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            td.style.outline = "";
            if (this._dropping) return;
            this._dropping = true;
            const dtPath = (e.dataTransfer?.getData("text/plain") || "").trim();
            const path = dtPath || this.dragSrcPath;
            if (!path) { this._dropping = false; return; }
            await this.updateNoteFrontmatter(path, actNum, actRaw, chapter);
            await new Promise(resolve => setTimeout(resolve, 500));
            await this.refresh();
            this._dropping = false;
        });
    }

    async createNoteInCell(actNum, actRaw, chapter, ctx, rootPaths) {
        const name = await this.promptValue("Note name:");
        if (!name || !name.trim()) return;

        const safeName = name.trim();

        let folderPath = null;
        for (const root of rootPaths) {
            const candidate = root + "/" + ctx;
            const folder = this.app.vault.getAbstractFileByPath(candidate);
            if (folder) { folderPath = candidate; break; }
        }
        if (!folderPath) {
            new obsidian.Notice("Could not find folder for column: " + ctx);
            return;
        }

        const filePath = folderPath + "/" + safeName + ".md";

        if (this.app.vault.getAbstractFileByPath(filePath)) {
            new obsidian.Notice("A note with that name already exists.");
            return;
        }

        try {
            const newFile = await this.app.vault.create(filePath, "");
            const leaf = this.app.workspace.getLeaf("tab");
            await leaf.openFile(newFile);
            await new Promise(resolve => setTimeout(resolve, 800));

            const numericAct = parseActNum(actRaw);
            const actValue = actRaw.trim() === String(numericAct) ? numericAct : actRaw;
            await this.app.fileManager.processFrontMatter(newFile, (fm) => {
                fm["act"] = actValue;
                fm["chapter"] = chapter;
            });

            await new Promise(resolve => setTimeout(resolve, 500));
            await this.refresh();
        } catch (err) {
            new obsidian.Notice("Failed to create note: " + err.message);
        }
    }

    wireNewCellDropZone(zone, actInputEl, chInputEl) {
        zone.ondragover = (e) => {
            e.preventDefault();
            zone.style.background = "var(--background-secondary)";
        };
        zone.ondragleave = () => {
            zone.style.background = "";
        };
        zone.ondrop = async (e) => {
            e.preventDefault();
            zone.style.background = "";

            const dtPath = e.dataTransfer?.getData("text/plain") || "";
            console.log('[PlotGrid] ondrop fired. dataTransfer path:', JSON.stringify(dtPath), 'dragSrcPath:', JSON.stringify(this.dragSrcPath));
            const path = dtPath.trim() || this.dragSrcPath;
            console.log('[PlotGrid] resolved path:', JSON.stringify(path));
            if (!path) { console.log('[PlotGrid] no path, aborting'); return; }

            const actRaw = actInputEl.value.trim();
            const chRaw = chInputEl.value.trim();

            if (!actRaw || !chRaw) {
                new obsidian.Notice("Fill in the Act and Chapter fields before dropping.");
                return;
            }

            const chapter = Number(chRaw);
            if (!Number.isFinite(chapter)) {
                new obsidian.Notice("Invalid chapter number.");
                return;
            }

            const actNum = parseActNum(actRaw);
            await this.updateNoteFrontmatter(path, actNum, actRaw, chapter);
            actInputEl.value = "";
            chInputEl.value = "";
            await this.refresh();
        };
    }

    promptValue(message) {
        return new Promise((resolve) => {
            const modal = document.createElement("div");
            modal.style.cssText =
                "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;" +
                "justify-content:center;z-index:9999;";

            const box = modal.appendChild(document.createElement("div"));
            box.style.cssText =
                "background:var(--background-primary);padding:24px;border-radius:10px;min-width:300px;" +
                "display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);";

            const msg = box.appendChild(document.createElement("p"));
            msg.textContent = message;
            msg.style.margin = "0";

            const input = box.appendChild(document.createElement("input"));
            input.type = "text";
            input.style.cssText =
                "padding:6px 10px;border-radius:4px;border:1px solid var(--background-modifier-border);" +
                "background:var(--background-secondary);color:var(--text-normal);font-size:14px;";

            const btnRow = box.appendChild(document.createElement("div"));
            btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

            const ok = btnRow.appendChild(document.createElement("button"));
            ok.textContent = "OK";
            ok.style.cssText = "padding:4px 16px;border-radius:4px;cursor:pointer;";
            ok.onclick = () => { document.body.removeChild(modal); resolve(input.value); };

            const cancel = btnRow.appendChild(document.createElement("button"));
            cancel.textContent = "Cancel";
            cancel.style.cssText = "padding:4px 16px;border-radius:4px;cursor:pointer;";
            cancel.onclick = () => { document.body.removeChild(modal); resolve(null); };

            input.onkeydown = (e) => {
                if (e.key === "Enter") ok.click();
                if (e.key === "Escape") cancel.click();
            };

            document.body.appendChild(modal);
            input.focus();
        });
    }

    async updateNoteFrontmatter(filePath, actNum, actRaw, chapter) {
        console.log('[PlotGrid] updateNoteFrontmatter called:', filePath, 'act:', actRaw, 'chapter:', chapter);
        const file = this.app.vault.getAbstractFileByPath(filePath);
        console.log('[PlotGrid] file lookup result:', file);
        if (!(file instanceof obsidian.TFile)) { console.log('[PlotGrid] not a TFile, aborting'); return; }

        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const numericAct = parseActNum(actRaw);
            const actValue = actRaw.trim() === String(numericAct) ? numericAct : actRaw;
            fm["act"] = actValue;
            fm["chapter"] = chapter;
        });

        new obsidian.Notice(`✓ ${file.basename} → Act ${actRaw}, Chapter ${chapter}`);
    }

    async loadRows(rootPaths) {
        const rows = [];
        const skipped = { noContext: 0, noFm: 0, noChapter: 0, noAct: 0 };
        for (const file of this.app.vault.getMarkdownFiles()) {
            let context = null;
            for (const root of rootPaths) {
                if (file.path.startsWith(root + "/")) {
                    const parts = file.path.slice(root.length + 1).split("/");
                    if (parts.length >= 2) {
                        context = parts[0];
                        break;
                    }
                }
            }
            if (!context) { skipped.noContext++; continue; }

            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (!fm) { skipped.noFm++; continue; }

            let chapter = Number(fm.chapter ?? fm.Chapter);
            if (!Number.isFinite(chapter)) {
                const m = file.name.match(/^(\d+)/);
                chapter = m ? Number(m[1]) : NaN;
            }
            if (!Number.isFinite(chapter)) { skipped.noChapter++; continue; }

            const act = fm.act ?? fm.Act;
            if (act === undefined || act === null) { skipped.noAct++; continue; }

            rows.push({
                file,
                context,
                chapter,
                act,
                actNum: parseActNum(act),
                actRaw: String(act),
                color: normalizeColor(fm.color ?? fm.Color),
                summary: fm.summary ?? fm.Summary ?? null,
            });
        }
        this._lastSkipped = skipped;
        return rows;
    }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    books: [],
};

class PlotGridSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "PlotGrid Settings" });

        containerEl.createEl("p", {
            text: "Configure each book with a working title and the vault folder path(s) to scan. " +
                "Multiple root paths per book are supported (one per line).",
            attr: { style: "color:var(--text-muted);font-size:13px;margin-bottom:16px;" },
        });

        const books = this.plugin.settings.books;

        // Render each book entry
        for (let i = 0; i < books.length; i++) {
            this.renderBookEntry(containerEl, books, i);
        }

        // Add book button
        const addBtn = containerEl.createEl("button", { text: "+ Add Book" });
        addBtn.style.cssText =
            "margin-top:12px;padding:6px 18px;border-radius:6px;cursor:pointer;" +
            "font-size:13px;font-weight:500;";
        addBtn.onclick = async () => {
            books.push({ title: "", root: "" });
            await this.plugin.saveSettings();
            this.display();
        };

        containerEl.createEl("p", {
            text: "After changing settings, click ↻ Refresh in the PlotGrid view to reload.",
            attr: { style: "color:var(--text-muted);font-size:12px;margin-top:16px;" },
        });
    }

    renderBookEntry(containerEl, books, index) {
        const book = books[index];

        const wrapper = containerEl.createDiv();
        wrapper.style.cssText =
            "border:1px solid var(--background-modifier-border);border-radius:8px;" +
            "padding:12px 16px;margin-bottom:12px;background:var(--background-secondary);";

        // Title row with delete button
        const titleRow = wrapper.createDiv();
        titleRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";

        const label = titleRow.createEl("span", { text: `Book ${index + 1}` });
        label.style.cssText = "font-weight:600;font-size:13px;color:var(--text-muted);min-width:55px;";

        const deleteBtn = titleRow.createEl("button", { text: "✕ Remove" });
        deleteBtn.style.cssText =
            "margin-left:auto;padding:2px 10px;border-radius:4px;cursor:pointer;" +
            "font-size:11px;color:var(--text-error);";
        deleteBtn.onclick = async () => {
            books.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
        };

        // Move up / down buttons
        if (index > 0) {
            const upBtn = titleRow.createEl("button", { text: "↑" });
            upBtn.style.cssText = "padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px;";
            upBtn.onclick = async () => {
                [books[index - 1], books[index]] = [books[index], books[index - 1]];
                await this.plugin.saveSettings();
                this.display();
            };
        }
        if (index < books.length - 1) {
            const downBtn = titleRow.createEl("button", { text: "↓" });
            downBtn.style.cssText = "padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px;";
            downBtn.onclick = async () => {
                [books[index], books[index + 1]] = [books[index + 1], books[index]];
                await this.plugin.saveSettings();
                this.display();
            };
        }

        // Working title
        new obsidian.Setting(wrapper)
            .setName("Working title")
            .setDesc("Displayed at the top of this book's grid column.")
            .addText((text) => {
                text
                    .setPlaceholder("e.g. Neon Arcology")
                    .setValue(book.title)
                    .onChange(async (value) => {
                        book.title = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Root path(s)
        new obsidian.Setting(wrapper)
            .setName("Root path(s)")
            .setDesc("Vault folder path(s) to scan for this book. One path per line.")
            .addTextArea((text) => {
                text.inputEl.style.cssText = "width:100%;min-height:60px;font-family:monospace;font-size:13px;";
                text
                    .setPlaceholder("e.g. cyberpunk-series/book-one")
                    .setValue(book.root)
                    .onChange(async (value) => {
                        book.root = value;
                        await this.plugin.saveSettings();
                    });
            });
    }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class PlotGridPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE, (leaf) => new PlotGridView(leaf, this));
        this.addRibbonIcon(RIBBON_ICON, "Open PlotGrid", () => {
            this.activateView();
        });
        this.addSettingTab(new PlotGridSettingTab(this.app, this));
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    }

    async loadSettings() {
        const loaded = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

        // Migrate old single-root format to multi-book format
        if (loaded && loaded.blueprintRoot && (!this.settings.books || this.settings.books.length === 0)) {
            this.settings.books = [{
                title: "Book 1",
                root: loaded.blueprintRoot,
            }];
            delete this.settings.blueprintRoot;
            await this.saveSettings();
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getLeaf("tab");
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }
}

module.exports = PlotGridPlugin;