import { Plugin, FuzzySuggestModal, TFile } from "obsidian";
import { VIEW_TYPE_PDF_COMMENTER, PdfCommenterView } from './view';

class PdfFileSuggestModal extends FuzzySuggestModal<TFile> {
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter(f => f.extension === 'pdf');
	}
	getItemText(item: TFile): string {
		return item.path;
	}
	onChooseItem(item: TFile): void {
		this.app.workspace.getLeaf(false).openFile(item);
	}
}

export default class PdfCommenterPlugin extends Plugin {
	async onload() {
		// Register the custom view
		this.registerView(
			VIEW_TYPE_PDF_COMMENTER,
			// NOTE: Obsidian's runtime manifest includes `dir` (folder name under .obsidian/plugins).
			// This can differ from `id` during development if the folder name doesn't match.
			(leaf) => new PdfCommenterView(leaf, { pluginId: this.manifest.id, pluginDir: (this.manifest as any).dir ?? this.manifest.id })
		);

		// Claim .pdf extension from built-in viewer
		// @ts-expect-error — undocumented internal API
		this.app.viewRegistry.unregisterExtensions(['pdf']);
		this.registerExtensions(['pdf'], VIEW_TYPE_PDF_COMMENTER);

		// Ribbon icon opens a fuzzy file picker filtered to PDFs
		this.addRibbonIcon("eye", "Open PDF", () => {
			new PdfFileSuggestModal(this.app).open();
		});

		// Command to open PDF picker
		this.addCommand({
			id: "open-pdf-viewer",
			name: "Open PDF",
			callback: () => {
				new PdfFileSuggestModal(this.app).open();
			}
		});
	}

	async onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PDF_COMMENTER);
		// Restore built-in PDF viewer
		// @ts-expect-error
		this.app.viewRegistry.unregisterExtensions(['pdf']);
		// @ts-expect-error
		this.app.viewRegistry.registerExtensions(['pdf'], 'pdf');
	}
}
