import { Plugin, MarkdownView } from "obsidian";
import { VIEW_TYPE_EXAMPLE, ExampleView } from './view';
  
/**
 * Minimal example of an Obsidian plugin
 */
export default class MinimalExamplePlugin extends Plugin {
    async onload() {
        console.log("Minimal example plugin is loading");
        // Register the custom view
        this.registerView(
            VIEW_TYPE_EXAMPLE,
            // NOTE: Obsidian's runtime manifest includes `dir` (folder name under .obsidian/plugins).
            // This can differ from `id` during development if the folder name doesn't match.
            (leaf) => new ExampleView(leaf, { pluginId: this.manifest.id, pluginDir: (this.manifest as any).dir ?? this.manifest.id })
        );
        // Add ribbon icon to open the view
        this.addRibbonIcon(
            "eye", // You can use any Lucide icon name here
            "Open Example View",
            this.openExampleView.bind(this)
        );
        // Add command to open the view
        this.addCommand({
            id: "open-example-view",
            name: "Open Example View",
            callback: this.openExampleView.bind(this)
        });
    }
    async onunload() {
        // Clean up
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_EXAMPLE);
    }
    /**
     * Opens the example view in a new leaf
     */
    async openExampleView() {
        // First try to get current note's content
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            console.log("Active note found:", activeView.getDisplayText());
        }
        // Check if view is already open
        const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE)[0];
        if (existingLeaf) {
            // Focus existing leaf
            this.app.workspace.revealLeaf(existingLeaf);
            return;
        }
        // Open in the current active leaf
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.setViewState({
            type: VIEW_TYPE_EXAMPLE,
            active: true
        });
        this.app.workspace.revealLeaf(leaf);
    }
}
