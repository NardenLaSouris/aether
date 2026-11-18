import { FolderKanban, FolderPlus, MessageSquarePlus, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { Badge, Button, confirmAction, EmptyState, IconButton } from '../components/ui'
import { formatRelative } from '../lib/format'
import { useAppStore } from '../stores/appStore'

export function ProjectsPage() {
  const projects = useAppStore((state) => state.projects)
  const conversations = useAppStore((state) => state.conversations)
  const addProject = useAppStore((state) => state.addProject)
  const removeProject = useAppStore((state) => state.removeProject)
  const create = useAppStore((state) => state.createConversation)
  const open = useAppStore((state) => state.openConversation)
  const loadProjects = useAppStore((state) => state.loadProjects)
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <div className="mb-6 flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold">Projets</h1>
          <span className="text-[13px] text-ink-faint">Dossiers locaux dans lesquels Claude Code travaille.</span>
          <div className="flex-1" />
          <Button variant="primary" icon={<FolderPlus className="size-4" />} onClick={() => void addProject()}>
            Ajouter un dossier
          </Button>
        </div>
        {projects.length === 0 ? (
          <EmptyState icon={<FolderKanban className="size-5" />} title="Aucun projet" description="Ajoutez un répertoire local. Chaque conversation de ce projet s’exécutera dans ce dossier." action={<Button variant="primary" icon={<FolderPlus className="size-4" />} onClick={() => void addProject()}>Ajouter un dossier</Button>} />
        ) : (
          <div className="grid gap-4">
            {projects.map((project) => {
              const projectConversations = conversations.filter((conversation) => conversation.projectId === project.id)
              return (
                <section key={project.id} className="rounded-lg border border-line bg-panel shadow-panel">
                  <header className="flex items-center gap-3 px-4 py-3">
                    <div className="flex size-9 items-center justify-center rounded-md border border-gold/25 bg-forest text-gold">
                      <FolderKanban className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-display text-[14px] font-semibold">{project.name}</div>
                      <div className="selectable truncate font-mono text-[11.5px] text-ink-faint">{project.directoryPath}</div>
                    </div>
                    <div className="flex-1" />
                    <span className="text-[11px] text-ink-faint">Ouvert {formatRelative(project.lastOpenedAt)}</span>
                    <Button size="sm" variant="subtle" icon={<MessageSquarePlus className="size-3.5" />} onClick={() => void create(project.id)}>
                      Nouvelle conversation
                    </Button>
                    <IconButton
                      label="Retirer le projet d’Aether"
                      onClick={async () => {
                        const confirmed = await confirmAction({ title: 'Retirer ce projet ?', message: 'Le projet est retiré d’Aether uniquement. Aucun fichier n’est supprimé et ses conversations sont conservées.', confirmLabel: 'Retirer', danger: true })
                        if (confirmed) await removeProject(project.id)
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </header>
                  {projectConversations.length > 0 && (
                    <ul className="border-t border-line px-2 py-1.5">
                      {projectConversations.slice(0, 8).map((conversation) => (
                        <li key={conversation.id}>
                          <button type="button" onClick={() => void open(conversation.id)} className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-white/4">
                            <span className="truncate text-[13px]">{conversation.title}</span>
                            {conversation.origin === 'imported' && <Badge tone="sage">reprise</Badge>}
                            <span className="ml-auto text-[11px] text-ink-faint">{formatRelative(conversation.updatedAt)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
