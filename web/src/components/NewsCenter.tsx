import { motion, type Transition, type Variants } from 'framer-motion'
import { News } from './cards/News'
import { NoteReader } from './NoteReader'
import { useNoteReader } from '../lib/useNoteReader'
import { useData } from '../lib/useData'
import { fetchWikiPages } from '../lib/api'

// The News tab: the optional news-ingest addon's headlines, on its own top-level
// tab. The card itself stays the runtime gate (GET /api/addons) — renders null
// here exactly as it did embedded in the Home tab, so a kit without the addon
// gets an empty grid rather than a broken one.
const VAULT = 'atlas'

const grid: Variants = { hidden: { opacity: 0 }, show: { opacity: 1 } }
const gridStagger: Transition = { staggerChildren: 0.07, delayChildren: 0.05 }

export function NewsCenter() {
  // Every headline opens its own Wiki/Sources page, same reader used by the
  // other tabs.
  const { data: pages } = useData(() => fetchWikiPages(VAULT))
  const { path, missing, canGoBack, openPath, navigate, back, close } = useNoteReader(pages)

  return (
    <>
      <motion.div
        variants={grid}
        initial="hidden"
        animate="show"
        transition={gridStagger}
        className="cc-grid grid grid-cols-12 gap-4 px-4 pb-12 sm:px-6"
      >
        <News className="col-span-12" onOpenWiki={openPath} />
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
