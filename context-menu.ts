/**
 * Action for the context menu
 */
export interface ContextMenuAction {
    id: string;
    label: string;
    icon?: string;
    callback: (selectedText: string) => void;
}

/**
 * Custom context menu for PDF viewer
 */
export class ContextMenu {
    private menuEl: HTMLElement | null = null;
    private actions: ContextMenuAction[];
    private currentText: string = '';

    constructor(actions: ContextMenuAction[]) {
        this.actions = actions;
        this.createMenu();

        // Hide menu when clicking outside
        activeDocument.addEventListener('click', (e) => {
            if (this.menuEl && !this.menuEl.contains(e.target as Node)) {
                this.hide();
            }
        });

        // Hide menu on scroll
        activeDocument.addEventListener('scroll', () => this.hide(), true);

        // Hide menu on escape
        activeDocument.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hide();
        });
    }

    /**
     * Create the menu element
     */
    private createMenu(): void {
        const menuEl = activeDocument.body.createDiv({ cls: 'pdf-context-menu' });
        menuEl.addClass('is-hidden');
        this.menuEl = menuEl;

        // Add menu items
        for (const action of this.actions) {
            const item = menuEl.createDiv({ cls: 'pdf-context-menu-item' });
            item.dataset.actionId = action.id;

            if (action.icon) {
                item.createSpan({ cls: 'pdf-context-menu-icon', text: action.icon });
            }

            item.createSpan({ cls: 'pdf-context-menu-label', text: action.label });

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                action.callback(this.currentText);
                this.hide();
            });
        }
    }

    /**
     * Show the context menu at the specified position
     */
    show(x: number, y: number, selectedText: string): void {
        if (!this.menuEl || !selectedText) return;

        this.currentText = selectedText;

        // Position the menu
        this.menuEl.setCssStyles({ left: `${x}px`, top: `${y}px` });
        this.menuEl.removeClass('is-hidden');

        // Adjust if menu goes off screen
        const rect = this.menuEl.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (rect.right > viewportWidth) {
            this.menuEl.setCssStyles({ left: `${viewportWidth - rect.width - 10}px` });
        }

        if (rect.bottom > viewportHeight) {
            this.menuEl.setCssStyles({ top: `${viewportHeight - rect.height - 10}px` });
        }
    }

    /**
     * Hide the context menu
     */
    hide(): void {
        if (this.menuEl) {
            this.menuEl.addClass('is-hidden');
        }
        this.currentText = '';
    }

    /**
     * Update the actions
     */
    setActions(actions: ContextMenuAction[]): void {
        this.actions = actions;
        if (this.menuEl) {
            this.menuEl.remove();
        }
        this.createMenu();
    }

    /**
     * Destroy the context menu
     */
    destroy(): void {
        if (this.menuEl) {
            this.menuEl.remove();
            this.menuEl = null;
        }
    }
}
