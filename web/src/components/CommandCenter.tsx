import { useEffect } from 'preact/hooks'
import { motion, type Transition, type Variants } from 'framer-motion'
import { Hero } from './cards/Hero'
import { ClaudeLogin } from './cards/ClaudeLogin'
import { SearchBar } from './SearchBar'
import { Scorecard } from './cards/Scorecard'
import { KnowledgeAgents } from './cards/KnowledgeAgents'
import { Voice } from './cards/Voice'
import { Projects } from './cards/Projects'
import { NoteReader } from './NoteReader'
import { useNoteReader } from '../lib/useNoteReader'
import { DashboardProvider } from '../lib/dashboard'
import { useData } from '../lib/useData'
import { refreshGithub, fetchWikiPages } from '../lib/api'

// The Home search + reader target the Atlas vault (the typed, queryable KB).
const VAULT = 'atlas'

const grid: Variants = { hidden: { opacity: 0 }, show: { opacity: 1 } }
const gridStagger: Transition = { staggerChildren: 0.07, delayChildren: 0.05 }

export function CommandCenter() {
  return (
    <DashboardProvider>
      <CommandCenterInner />
    </DashboardProvider>
  )
}

function CommandCenterInner() {
  // Atlas page manifest — resolves wikilinks followed inside the reader.
  const { data: pages } = useData(() => fetchWikiPages(VAULT))
  const { path, missing, canGoBack, openPath, navigate, back, close } = useNoteReader(pages)

  // On load, kick the optional server-side GitHub scorecard refresh (cooldown-
  // guarded; a no-op unless you configured scripts/refresh-github.mjs + a token).
  useEffect(() => {
    refreshGithub()
  }, [])

  return (
    <>
      <motion.div
        variants={grid}
        initial="hidden"
        animate="show"
        transition={gridStagger}
        className="cc-grid grid grid-cols-12 gap-4 px-4 pb-12 sm:px-6"
      >
        <Hero />
        {/* Runtime-gated (docs/ADDONS.md), and even then renders nothing unless
            a renewal is actually waiting on a human — see addons/claude-login. */}
        <ClaudeLogin className="col-span-12" />
        <SearchBar onOpenWiki={openPath} vault={VAULT} />
        <Scorecard className="col-span-12" />
        {/* The Atlas Agent — the orchestrator chat ("steer Atlas for everything")
            and the dashboard's main control surface. It grounds answers in the
            typed Atlas graph and can spawn/steer the other agents. */}
        <KnowledgeAgents className="col-span-12" vault={VAULT} />
        {/* Same runtime gate, for the optional voice addon: spoken recaps of
            fleet events. Null wherever the addon is not enabled. */}
        <Voice className="col-span-12" />
        <Projects />
      </motion.div>

      <NoteReader
        path={path}
        missing={missing}
        vault={VAULT}
        canGoBack={canGoBack}
        onBack={back}
        onClose={close}
        onWikiLink={navigate}
      />
    </>
  )
}
