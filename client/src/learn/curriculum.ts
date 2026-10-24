// Learner-mode curriculum. Every position is checked by server/scripts/check-curriculum.ts
// (each move task must have a legal solution, each mate task a mate in one).

export type Step =
  | { t: "info"; title: string; text: string; fen?: string; arrows?: [string, string][]; marks?: string[] }
  | {
      t: "move"; prompt: string; fen: string; hint: string;
      from?: string;            // the piece the task is about (other pieces get a gentle nudge)
      to?: string[];            // accept a legal move that lands on one of these squares
      uci?: string[];           // or accept exact moves
      any?: boolean;            // any legal move is fine (escape from check)
      check?: boolean;          // accept a move that gives check
      mate?: boolean;           // accept a checkmating move
      marks?: string[];         // squares shown as targets
      wrong?: Record<string, string>; // message by destination square for tempting wrong answers
      success?: string;
    }
  | { t: "click"; prompt: string; to: string[]; hint: string }
  | { t: "quiz"; q: string; options: string[]; answer: number; explain: string; fen?: string };

export interface Lesson { key: string; title: string; blurb: string; minutes: number; steps: Step[] }

const KINGS_ONLY = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";

export const LESSONS: Lesson[] = [
  {
    key: "board", title: "The board and the goal", blurb: "Squares, pieces and what winning means", minutes: 4,
    steps: [
      { t: "info", title: "Welcome to chess", text: "Chess is a game for two players on a board of 64 squares. One player has the white pieces and the other has the black pieces. White always moves first, then you take turns. Each turn you move one piece.", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" },
      { t: "quiz", q: "How many squares does a chessboard have?", options: ["32", "64", "100"], answer: 1, explain: "8 rows times 8 columns makes 64 squares, alternating light and dark." },
      { t: "quiz", q: "Which colour moves first?", options: ["Black", "White", "Whoever is older"], answer: 1, explain: "White always makes the first move." },
      { t: "info", title: "Naming the squares", text: "Columns are called files and go from a to h. Rows are called ranks and go from 1 to 8. Every square has a name: its file letter and rank number. The square in the middle-left of White's side is e2, for example. Names help you follow along with lessons and coaches.", fen: KINGS_ONLY, marks: ["e2", "e4"] },
      { t: "click", prompt: "Click the square called e4.", to: ["e4"], hint: "Find the letter e along the bottom, then count up four rows." },
      { t: "click", prompt: "Click the square called d5.", to: ["d5"], hint: "Letter d, then count up five rows." },
      { t: "info", title: "The goal", text: "The goal is to trap the other player's king so it cannot escape. That is called checkmate, and it wins the game. You don't need to capture the king. You only need to attack it so it has no safe way out. You will practise this later.", fen: "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", arrows: [["a1", "a8"]] },
      { t: "quiz", q: "What is the goal of chess?", options: ["Capture the most pieces", "Checkmate the other king", "Get all your pawns across the board"], answer: 1, explain: "Capturing pieces helps, but the game is won by checkmate." },
    ],
  },
  {
    key: "pawn", title: "The pawn", blurb: "Small but important", minutes: 4,
    steps: [
      { t: "info", title: "Pawns move forward", text: "Pawns move straight forward, one square at a time. They can never move backwards. On a pawn's very first move, it may jump forward two squares instead.", fen: "4k3/8/8/8/8/8/4P3/7K w - - 0 1", marks: ["e3", "e4"] },
      { t: "move", prompt: "Click the pawn, then move it forward two squares to e4.", fen: "4k3/8/8/8/8/8/4P3/7K w - - 0 1", from: "e2", uci: ["e2e4"], marks: ["e4"], hint: "Click the pawn on e2, then click e4. The dots show where it can go." },
      { t: "info", title: "Pawns capture sideways", text: "Pawns capture differently from how they move: they take one square diagonally forward. They cannot capture the piece straight in front of them. That piece simply blocks them.", fen: "4k3/8/8/3p4/4P3/8/8/7K w - - 0 1", arrows: [["e4", "d5"]] },
      { t: "move", prompt: "Capture the black pawn on d5 with your pawn.", fen: "4k3/8/8/3p4/4P3/8/8/7K w - - 0 1", from: "e4", uci: ["e4d5"], marks: ["d5"], hint: "Click your pawn, then click the black pawn diagonally in front of it." },
      { t: "quiz", q: "Can a pawn capture the piece directly in front of it?", options: ["Yes", "No, only diagonally"], answer: 1, explain: "Pawns move straight but capture diagonally." },
    ],
  },
  {
    key: "rook", title: "The rook", blurb: "Straight lines, any distance", minutes: 4,
    steps: [
      { t: "info", title: "Rooks move in straight lines", text: "A rook moves any number of squares in a straight line: up, down, left or right. It cannot jump over other pieces.", fen: "4k3/8/8/8/8/8/8/R6K w - - 0 1", arrows: [["a1", "a8"], ["a1", "g1"]] },
      { t: "move", prompt: "Move the rook straight up to a5.", fen: "4k3/8/8/8/8/8/8/R6K w - - 0 1", from: "a1", uci: ["a1a5"], marks: ["a5"], hint: "Click the rook, then click a5, four squares up." },
      { t: "move", prompt: "Now move the rook sideways to d5.", fen: "4k3/8/8/R7/8/8/8/7K w - - 0 1", from: "a5", uci: ["a5d5"], marks: ["d5"], hint: "Same row, to the right: d5." },
      { t: "move", prompt: "Capture the black pawn on d4 with your rook.", fen: "4k3/8/8/8/3p4/8/8/3R3K w - - 0 1", from: "d1", uci: ["d1d4"], marks: ["d4"], hint: "The pawn is straight up from your rook. Click the rook, then the pawn." },
      { t: "quiz", q: "How does a rook move?", options: ["Diagonally", "In an L shape", "In straight lines"], answer: 2, explain: "Up, down, left and right, as far as the way is clear." },
    ],
  },
  {
    key: "bishop", title: "The bishop", blurb: "Diagonals only", minutes: 4,
    steps: [
      { t: "info", title: "Bishops move diagonally", text: "A bishop moves any number of squares diagonally. Because of that, a bishop always stays on the same colour of square it started on. Each side has one light-square bishop and one dark-square bishop.", fen: "4k3/8/8/8/8/8/8/2B4K w - - 0 1", arrows: [["c1", "h6"], ["c1", "a3"]] },
      { t: "move", prompt: "Move the bishop diagonally to f4.", fen: "4k3/8/8/8/8/8/8/2B4K w - - 0 1", from: "c1", uci: ["c1f4"], marks: ["f4"], hint: "Click the bishop, then click f4: up and to the right." },
      { t: "move", prompt: "Capture the black pawn on g5.", fen: "4k3/8/8/6p1/8/8/8/2B4K w - - 0 1", from: "c1", uci: ["c1g5"], marks: ["g5"], hint: "The pawn is on the same diagonal as your bishop." },
      { t: "quiz", q: "A bishop starts on a light square. Can it ever land on a dark square?", options: ["Yes", "No, never"], answer: 1, explain: "Diagonal moves keep it on the same colour for the whole game." },
    ],
  },
  {
    key: "queen", title: "The queen", blurb: "The most powerful piece", minutes: 4,
    steps: [
      { t: "info", title: "The queen does it all", text: "The queen moves like a rook and a bishop combined: any number of squares in a straight line or diagonally. She is the most powerful piece, but don't lose her carelessly.", fen: "4k3/8/8/8/3Q4/8/8/7K w - - 0 1", arrows: [["d4", "d8"], ["d4", "h8"], ["d4", "a4"], ["d4", "a1"]] },
      { t: "move", prompt: "Move the queen straight down to d1.", fen: "4k3/8/8/8/3Q4/8/8/7K w - - 0 1", from: "d4", uci: ["d4d1"], marks: ["d1"], hint: "Straight down the d column." },
      { t: "move", prompt: "Now move the queen diagonally to g7.", fen: "4k3/8/8/8/3Q4/8/8/7K w - - 0 1", from: "d4", uci: ["d4g7"], marks: ["g7"], hint: "Up and to the right, three squares." },
      { t: "quiz", q: "Which piece moves like a rook and a bishop together?", options: ["King", "Knight", "Queen"], answer: 2, explain: "The queen combines both movements." },
    ],
  },
  {
    key: "knight", title: "The knight", blurb: "The jumper", minutes: 5,
    steps: [
      { t: "info", title: "Knights move in an L", text: "A knight moves two squares in one direction and then one square sideways, like the letter L. The knight is the only piece that can jump over other pieces.", fen: "4k3/8/8/8/3N4/8/8/7K w - - 0 1", marks: ["b3", "b5", "c2", "c6", "e2", "e6", "f3", "f5"] },
      { t: "move", prompt: "Move the knight to f5.", fen: "4k3/8/8/8/3N4/8/8/7K w - - 0 1", from: "d4", uci: ["d4f5"], marks: ["f5"], hint: "Two squares right, one square up." },
      { t: "move", prompt: "The knight is boxed in by pawns. Jump it over to c3.", fen: "4k3/8/8/8/8/8/PPPPPPPP/1N5K w - - 0 1", from: "b1", uci: ["b1c3"], marks: ["c3"], hint: "Knights can jump. Click the knight, then c3." },
      { t: "move", prompt: "Capture the black pawn on d5 with your knight.", fen: "4k3/8/8/3p4/8/4N3/8/7K w - - 0 1", from: "e3", uci: ["e3d5"], marks: ["d5"], hint: "From e3: one square left and two up." },
      { t: "quiz", q: "Which piece can jump over other pieces?", options: ["Rook", "Knight", "Bishop"], answer: 1, explain: "Only the knight jumps." },
    ],
  },
  {
    key: "king", title: "The king", blurb: "Slow, precious and always in danger", minutes: 5,
    steps: [
      { t: "info", title: "The king moves one square", text: "The king can move one square in any direction. He is the most important piece. If your king is trapped, you lose. A king can never move onto a square that an enemy piece attacks.", fen: "4k3/8/8/8/4K3/8/8/8 w - - 0 1", marks: ["d3", "e3", "f3", "d4", "f4", "d5", "e5", "f5"] },
      { t: "move", prompt: "Move the king one square up, to e5.", fen: "4k3/8/8/8/4K3/8/8/8 w - - 0 1", from: "e4", uci: ["e4e5"], marks: ["e5"], hint: "One step straight up." },
      { t: "move", prompt: "The black rook on d3 attacks the whole d column and the third row. Move your king to a safe square.", fen: "4k3/8/8/8/8/3r4/8/4K3 w - - 0 1", from: "e1", to: ["e2", "f1", "f2"], marks: ["e2", "f1", "f2"], hint: "Try e2, f1 or f2. The d column and the third row are attacked by the rook.", wrong: { d1: "The rook attacks d1. A king can never step onto an attacked square.", d2: "The rook attacks d2. Try a square the rook can't reach." } },
      { t: "quiz", q: "Can a king move onto a square that an enemy piece attacks?", options: ["Yes, if he is brave", "No, never"], answer: 1, explain: "Moving into attack would be moving into check, which is illegal." },
    ],
  },
  {
    key: "values", title: "What pieces are worth", blurb: "Winning trades and not losing material", minutes: 4,
    steps: [
      { t: "info", title: "Piece values", text: "Players count piece value in points. A pawn is worth 1, a knight or bishop 3, a rook 5 and a queen 9. The king is priceless because losing him loses the game. Winning more points than you lose usually means you are ahead.", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" },
      { t: "quiz", q: "Which is worth more?", options: ["A rook", "A bishop"], answer: 0, explain: "A rook is worth about 5 points and a bishop about 3." },
      { t: "quiz", q: "You give up a knight (3) to capture a queen (9). Is that good?", options: ["Yes, you win 6 points", "No"], answer: 0, explain: "You gain 9 and lose 3, so you are 6 points ahead." },
      { t: "move", prompt: "Two black pieces can be captured: a pawn and a queen. Take the more valuable one.", fen: "4k3/p7/8/R3q3/8/8/8/7K w - - 0 1", from: "a5", uci: ["a5e5"], marks: ["a7", "e5"], hint: "The queen is worth 9 points and the pawn only 1. Your rook can reach the queen along the row.", wrong: { a7: "That wins a pawn, but the queen is worth 9 points. Look again." } },
    ],
  },
  {
    key: "check", title: "Check", blurb: "Attacking the king", minutes: 5,
    steps: [
      { t: "info", title: "What is check?", text: "When a king is attacked, it is in check. A player in check must fix it on the very next move. There are three ways: move the king away, block the attack with another piece, or capture the attacking piece.", fen: "4k3/8/8/8/8/8/8/r3K3 w - - 0 1", arrows: [["a1", "e1"]] },
      { t: "move", prompt: "Give check: move your rook so it attacks the black king.", fen: "4k3/8/8/8/8/8/8/R6K w - - 0 1", from: "a1", check: true, marks: ["a8"], hint: "The black king is on e8. Move the rook to the top row, a8.", success: "Check! The black king is attacked." },
      { t: "move", prompt: "Your king is in check from the black rook. Get out of check in any legal way.", fen: "4k3/8/8/8/8/8/8/r3K3 w - - 0 1", any: true, hint: "Click your king and move it off the first row, for example to e2.", success: "Well done. You escaped the check." },
      { t: "quiz", q: "You are in check. What are the ways out?", options: ["Only moving the king", "Move the king, block, or capture the attacker", "Ignore it and keep playing"], answer: 1, explain: "Move away, block, or capture. Ignoring check is not allowed." },
    ],
  },
  {
    key: "mate", title: "Checkmate", blurb: "How games are won", minutes: 6,
    steps: [
      { t: "info", title: "Checkmate wins", text: "Checkmate is a check from which there is no escape: the king cannot move to safety, nothing can block, and nothing can capture the attacker. The game ends immediately and the player who gave checkmate wins.", fen: "R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1", arrows: [["a8", "g8"]] },
      { t: "move", prompt: "Checkmate in one move! The black king is stuck behind its own pawns. Move your rook to the top row.", fen: "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", from: "a1", mate: true, marks: ["a8"], hint: "Rook to a8. The black pawns trap their own king.", success: "Checkmate! This pattern is called a back-rank mate." },
      { t: "move", prompt: "Find a checkmate with your queen.", fen: "7k/8/6K1/8/8/8/8/Q7 w - - 0 1", mate: true, hint: "Try moving the queen to the top row, to a8. Your king already guards the escape squares.", success: "Checkmate! Your king and queen worked together." },
      { t: "info", title: "Stalemate is a draw", text: "If a player has no legal move but is NOT in check, the game is a draw called stalemate. Careful: when you are far ahead, don't trap the king so completely that he has no moves but isn't attacked. In this picture it is Black's turn, the king is not in check, and every square around it is covered.", fen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1" },
      { t: "quiz", q: "It's Black's turn. The king is not in check but has no legal moves. What happens?", options: ["White wins", "It is a draw (stalemate)", "Black loses a piece"], answer: 1, explain: "No legal moves and not in check is a stalemate, so the game is a draw.", fen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1" },
    ],
  },
  {
    key: "special", title: "Special moves", blurb: "Castling, promotion and en passant", minutes: 6,
    steps: [
      { t: "info", title: "Castling", text: "Castling protects your king and activates a rook in one move. The king moves two squares toward a rook and the rook jumps to the other side of him. You can only castle if neither piece has moved yet, there is nothing in between, and the king is not in check or passing through attacked squares.", fen: "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", arrows: [["e1", "g1"], ["h1", "f1"]] },
      { t: "move", prompt: "Castle kingside: move your king two squares toward the right-hand rook.", fen: "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", from: "e1", uci: ["e1g1"], marks: ["g1"], hint: "Click the king and then click g1.", success: "You castled! The king is safer and the rook is ready for action." },
      { t: "info", title: "Promotion", text: "When a pawn reaches the far end of the board, it must be promoted into a queen, rook, bishop or knight. Almost everyone picks a queen. That is why a pawn that gets through is so valuable.", fen: "4k3/6P1/8/8/8/8/8/7K w - - 0 1", arrows: [["g7", "g8"]] },
      { t: "move", prompt: "Push the pawn to the last row to promote it. In this lesson it becomes a queen.", fen: "4k3/6P1/8/8/8/8/8/7K w - - 0 1", from: "g7", uci: ["g7g8"], marks: ["g8"], hint: "One step forward to g8.", success: "A new queen! Promotion is a huge advantage." },
      { t: "info", title: "En passant", text: "A special pawn capture. If an enemy pawn jumps two squares and lands right beside your pawn, you may capture it as if it had moved just one square. You must do it immediately or the chance is gone. In this picture Black's pawn has just jumped to d5 next to your pawn on e5.", fen: "4k3/8/8/3pP3/8/8/8/7K w - d6 0 1", arrows: [["e5", "d6"]] },
      { t: "move", prompt: "Capture the black pawn en passant: move your pawn to d6.", fen: "4k3/8/8/3pP3/8/8/8/7K w - d6 0 1", from: "e5", uci: ["e5d6"], marks: ["d6"], hint: "Your pawn goes diagonally to d6, and the black pawn disappears.", success: "That's en passant, French for 'in passing'." },
      { t: "quiz", q: "Can you castle if your king has already moved?", options: ["Yes", "No"], answer: 1, explain: "Castling is only allowed if neither the king nor that rook has moved." },
    ],
  },
  {
    key: "plan", title: "How to start a game", blurb: "Three simple opening habits", minutes: 5,
    steps: [
      { t: "info", title: "Three opening habits", text: "1) Control the centre with your pawns. 2) Bring out your knights and bishops. 3) Castle early to protect your king. Following these three habits will keep you out of trouble while you learn.", fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2" },
      { t: "move", prompt: "Start the game with a good first move: push a centre pawn two squares (e4 or d4).", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", uci: ["e2e4", "d2d4"], marks: ["e4", "d4"], hint: "Move the pawn in front of your king or queen two squares forward.", success: "A great start. You control the centre." },
      { t: "move", prompt: "Black answered with e5. Now bring out a knight toward the centre.", fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", uci: ["g1f3", "b1c3"], marks: ["f3", "c3"], hint: "Move a knight from the back row to f3 or c3.", success: "Developing a knight: habit number two." },
      { t: "quiz", q: "Which of these is a good opening habit?", options: ["Move the same piece many times", "Castle early to protect your king", "Bring your queen out as soon as possible"], answer: 1, explain: "Castling keeps your king safe. Moving one piece repeatedly or bringing the queen out early usually wastes time." },
      { t: "info", title: "You're ready to play!", text: "You now know how every piece moves, how to win, and how to start. Play a game against the Beginner bot. It makes mistakes on purpose so you can practise. Don't worry about losing. Every game teaches you something.", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" },
    ],
  },
];
