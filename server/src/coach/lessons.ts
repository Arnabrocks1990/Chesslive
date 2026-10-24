// Authored, deterministic lesson content per mistake theme. Nothing here is LLM-generated, so it
// cannot hallucinate chess facts; the AI only chooses which lesson applies and when.
export interface Lesson { headline: string; why: string; habits: string[]; beforeEveryMove: string[] }

export const LESSONS: Record<string, Lesson> = {
  hanging_piece: {
    headline: "Stop leaving pieces undefended",
    why: "Most games below master level are decided by a piece that was simply left en prise. A two-second safety scan after choosing a move removes most of these.",
    habits: ["After you pick a move, look at the square you are moving to: is it attacked, and is it defended?", "Look at what your move stops defending, not just what it does.", "Re-check pieces that were defended only by the piece you are moving."],
    beforeEveryMove: ["Which of my pieces are undefended?", "What does my opponent's last move attack?", "Does my move leave anything loose?"],
  },
  missed_tactic: {
    headline: "Spot the forcing move first",
    why: "Tactics hide in forcing moves: checks, captures and threats. Looking at them first, in that order, finds shots you would otherwise skip.",
    habits: ["List every check, then every capture, then every direct threat for both sides.", "Look for two targets at once: forks, pins and skewers.", "If a move wins material by force, calculate the reply you like least."],
    beforeEveryMove: ["Checks? Captures? Threats?", "Is any enemy piece loose or overloaded?", "Can one move attack two things?"],
  },
  missed_mate: {
    headline: "Find the mate before the material",
    why: "A forced mate beats any material gain. When the enemy king is short of squares, check every check before anything else.",
    habits: ["Count the enemy king's escape squares.", "Try every check, even ones that look like they lose a piece.", "Look for the quiet move that removes the last escape."],
    beforeEveryMove: ["Is the enemy king short of squares?", "What checks do I have?", "Is there a quiet move that traps the king?"],
  },
  allowed_mate: {
    headline: "Keep your own king safe",
    why: "Blunders that allow a forced mate end the game instantly. Before moving, ask where your opponent's checks would go.",
    habits: ["List your opponent's checks after your intended move.", "Watch squares near your king that lose a defender.", "Do not move the pawns or pieces that shield your king without a reason."],
    beforeEveryMove: ["After my move, what checks does the opponent have?", "Is any defender of my king leaving?", "Can my king still breathe?"],
  },
  back_rank: {
    headline: "Give your king an escape square",
    why: "A king boxed in by its own pawns on the back rank can be mated by a single rook or queen. A luft (a pawn move that gives the king air) costs one tempo and avoids it.",
    habits: ["Check whether your back rank is covered by a rook or queen.", "Make luft (h3 or h6, g3 or g6) once the rooks come into play.", "Before trading your last back-rank defender, check what is left."],
    beforeEveryMove: ["Is my back rank guarded?", "Does my king have a flight square?", "What if the last rook leaves the rank?"],
  },
  opening_error: {
    headline: "Play principled openings",
    why: "Early mistakes usually come from breaking basic principles: leaving development behind, moving the same piece twice, or grabbing a pawn while undeveloped.",
    habits: ["Develop knights and bishops before moving a piece twice.", "Castle early, and do not open the position while your king is in the centre.", "Before taking a pawn, check what the capture allows."],
    beforeEveryMove: ["Is my king safe?", "Are my pieces developed?", "What is the opponent threatening?"],
  },
  endgame_conversion: {
    headline: "Convert winning positions calmly",
    why: "Winning positions slip away when we relax, rush, or allow counterplay. In endgames, activity and king position matter more than extra decorations.",
    habits: ["Trade pieces, not pawns, when ahead.", "Activate your king in endgames.", "Ask what your opponent's best counter-chance is before every move."],
    beforeEveryMove: ["What is my opponent's best chance?", "Is there a safe simplification?", "Is my king active?"],
  },
  time_trouble: {
    headline: "Spend time on the critical moves",
    why: "Many blunders come when the clock is low. Budget time: play known moves fast, and keep reserves for the moments the position gets sharp.",
    habits: ["Do not spend more than a set amount on early moves.", "Decide on the critical move by move 20 and plan the clock around it.", "Under a minute, favour safe, simple moves and keep the safety scan."],
    beforeEveryMove: ["How much time do I have?", "Is this a critical position?", "What is the safest good move?"],
  },
  other: {
    headline: "Slow down on the costly moves",
    why: "These mistakes do not fit one pattern, so the aim is a reliable routine that catches them.",
    habits: ["Say out loud what the opponent's last move does.", "Compare two candidate moves, not just one.", "Check for loose pieces and checks before moving."],
    beforeEveryMove: ["What changed?", "What are my candidates?", "Is anything loose?"],
  },
};

export const lessonFor = (theme: string | null | undefined): Lesson => LESSONS[theme ?? ""] ?? LESSONS.other;

// Plain English versions: same advice, no chess jargon. Shown when the player picks the Plain English tab.
export const PLAIN_LESSONS: Record<string, Lesson> = {
  hanging_piece: {
    headline: "Don't leave your pieces unprotected",
    why: "Many games are lost because a piece was left where the opponent could just take it for free. A quick safety check after you choose a move catches most of these.",
    habits: ["Once you pick a move, look at where the piece lands. Can the opponent take it? Does anything protect it?", "Check what your move stops protecting, not only what it does.", "If a piece was protected only by the piece you are about to move, check again."],
    beforeEveryMove: ["Which of my pieces does nobody protect?", "What is my opponent's last move aiming at?", "Does my move leave something open to be taken?"],
  },
  missed_tactic: {
    headline: "Look for the forcing move first",
    why: "Winning shots are often hidden in moves that force a reply: checks, captures and threats. Looking at them first, in that order, finds ideas you would otherwise miss.",
    habits: ["List every check, then every capture, then every threat, for both sides.", "Look for one move that attacks two things at once.", "If a move wins material, think about your opponent's best answer before playing it."],
    beforeEveryMove: ["Can I check, capture or threaten something?", "Is any enemy piece unprotected?", "Can one move attack two things?"],
  },
  missed_mate: {
    headline: "Look for checkmate before anything else",
    why: "A forced checkmate beats winning any amount of material. When the enemy king has few places to go, try every check first.",
    habits: ["Count the squares the enemy king can run to.", "Try every check, even ones that seem to lose a piece.", "Look for a quiet move that takes away the king's last escape."],
    beforeEveryMove: ["Does the enemy king have few places to go?", "Which checks do I have?", "Is there a quiet move that traps the king?"],
  },
  allowed_mate: {
    headline: "Keep your own king safe",
    why: "A move that lets your opponent checkmate you ends the game at once. Before you move, ask where your opponent could give check.",
    habits: ["Imagine your move, then list the checks your opponent would have.", "Be careful when a piece that guards your king moves away.", "Don't move the pawns in front of your king without a reason."],
    beforeEveryMove: ["After my move, where can the opponent give check?", "Is a defender of my king leaving?", "Does my king still have room to move?"],
  },
  back_rank: {
    headline: "Give your king room to breathe",
    why: "A king stuck behind its own pawns on the bottom row can be checkmated by one rook or queen. One small pawn move gives the king an escape square.",
    habits: ["Check whether a rook or queen guards your bottom row.", "Move a pawn next to your king (for example one step) so it has an exit.", "Before swapping off your last guard of that row, check what is left."],
    beforeEveryMove: ["Is my back row guarded?", "Can my king step anywhere?", "What if my last rook leaves?"],
  },
  opening_error: {
    headline: "Start the game with simple good habits",
    why: "Early mistakes usually come from skipping the basics: not bringing your pieces out, moving the same piece twice, or grabbing a pawn when you are not ready.",
    habits: ["Bring out your knights and bishops before moving a piece twice.", "Move your king to safety early, and don't open the game while it is in the middle.", "Before taking a pawn, ask what the capture lets your opponent do."],
    beforeEveryMove: ["Is my king safe?", "Have I brought my pieces out?", "What is my opponent threatening?"],
  },
  endgame_conversion: {
    headline: "Turn a winning position into a win",
    why: "Wins slip away when we relax, rush, or let the opponent create trouble. When ahead, keep it simple and keep control.",
    habits: ["When ahead, swap pieces, not pawns.", "Bring your king into the game when few pieces are left.", "Before each move, ask what your opponent's best trick could be."],
    beforeEveryMove: ["What is my opponent's best chance?", "Is there a safe way to simplify?", "Is my king active?"],
  },
  time_trouble: {
    headline: "Spend your time where it matters",
    why: "Many blunders happen when the clock is low. Play easy moves quickly and keep time for the moments the game gets sharp.",
    habits: ["Don't spend too long on early moves.", "Decide where the key moment is and save time for it.", "With little time left, pick safe simple moves and still do the safety check."],
    beforeEveryMove: ["How much time do I have?", "Is this an important moment?", "What is the safest good move?"],
  },
  other: {
    headline: "Slow down on the costly moves",
    why: "These mistakes don't share one pattern, so the goal is a steady routine that catches them.",
    habits: ["Say out loud what your opponent's last move does.", "Compare two possible moves, not just one.", "Check for loose pieces and checks before moving."],
    beforeEveryMove: ["What just changed?", "What are my options?", "Is anything unprotected?"],
  },
};

export const plainLessonFor = (theme: string | null | undefined): Lesson => PLAIN_LESSONS[theme ?? ""] ?? PLAIN_LESSONS.other;
