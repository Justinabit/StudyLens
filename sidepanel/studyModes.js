/*
  studyModes.js
  -------------
  The two interactive study modes in the side panel:
    - Quiz: multiple choice, instant feedback with explanations, a score
      screen, "retry missed", and a review of every answer.
    - Flashcards: flip cards, "Got it" / "Still learning", shuffle, and a
      "study missed only" pass.

  Both are plain state objects (so sidepanel.js can save them with the rest
  of the session) plus render functions that draw them into a container.
  Text from the AI is always inserted through Markdown.renderInline (which
  escapes it) or textContent - never as raw HTML.
*/

const StudyModes = (() => {
  const QUIZ_COUNTS = [5, 10, 15, 20];
  const QUIZ_DIFFICULTIES = [
    { id: "easy", label: "Easy" },
    { id: "mixed", label: "Mixed" },
    { id: "hard", label: "Hard" }
  ];
  const CARD_COUNTS = [10, 15, 20, 30];

  /* ---------------------------------------------------------------- *
   *  Tiny DOM helpers
   * ---------------------------------------------------------------- */

  function h(tag, props, children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === "className") node.className = value;
      else if (key === "html") node.innerHTML = value; // only ever passed escaped/rendered strings
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "style") node.style.cssText = value;
      else node.setAttribute(key, value === true ? "" : value);
    });
    (Array.isArray(children) ? children : children ? [children] : []).forEach((child) => {
      if (child) node.append(child);
    });
    return node;
  }

  function icon(name) {
    const span = document.createElement("span");
    span.className = "icon-wrap";
    span.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
    return span;
  }

  function pills(options, selected, onPick, label) {
    return h(
      "div",
      { className: "pills pills-small", role: "radiogroup", "aria-label": label },
      options.map((opt) =>
        h("button", {
          type: "button",
          className: "pill",
          role: "radio",
          "aria-checked": String(opt.id === selected),
          text: opt.label,
          onClick: (e) => {
            e.currentTarget.parentElement.querySelectorAll(".pill").forEach((p) => p.setAttribute("aria-checked", "false"));
            e.currentTarget.setAttribute("aria-checked", "true");
            onPick(opt.id);
          }
        })
      )
    );
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // A short burst of confetti from the top of the panel.
  function celebrate() {
    const layer = document.getElementById("confetti");
    if (!layer || prefersReducedMotion()) return;
    const colors = ["#ffc857", "#ff3131", "#2e7d6b", "#4c6ef5", "#f783ac", "#14213d"];
    for (let i = 0; i < 70; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.style.setProperty("--x", Math.random() * 100 + "vw");
      piece.style.setProperty("--drift", (Math.random() - 0.5) * 160 + "px");
      piece.style.setProperty("--spin", (Math.random() * 720 - 360) + "deg");
      piece.style.setProperty("--delay", Math.random() * 0.35 + "s");
      piece.style.setProperty("--duration", 1.6 + Math.random() * 1.2 + "s");
      piece.style.background = colors[i % colors.length];
      layer.appendChild(piece);
      setTimeout(() => piece.remove(), 3400);
    }
  }

  /* ---------------------------------------------------------------- *
   *  Quiz
   * ---------------------------------------------------------------- */

  function createQuiz(questions, meta) {
    return { questions, responses: questions.map(() => null), index: 0, finished: false, meta: meta || {} };
  }

  function quizScore(quiz) {
    return quiz.responses.reduce((sum, r, i) => sum + (r === quiz.questions[i].answer ? 1 : 0), 0);
  }

  function renderQuiz(container, quiz, actions) {
    container.replaceChildren(quiz.finished ? quizResults(quiz, actions) : quizQuestion(quiz, actions));
  }

  function quizQuestion(quiz, actions) {
    const q = quiz.questions[quiz.index];
    const total = quiz.questions.length;
    const answered = quiz.responses[quiz.index] !== null;

    const feedback = h("div", { className: "quiz-feedback", "aria-live": "polite" });
    const nextBtn = h("button", {
      type: "button",
      className: "btn btn-primary",
      disabled: !answered,
      onClick: () => {
        if (quiz.index < total - 1) quiz.index += 1;
        else quiz.finished = true;
        actions.changed();
        renderQuiz(actions.container(), quiz, actions);
      }
    }, [h("span", { text: quiz.index < total - 1 ? "Next" : "See results" }), icon("arrow-right")]);

    const optionButtons = q.options.map((option, i) =>
      h("button", {
        type: "button",
        className: "quiz-option",
        "data-index": String(i),
        onClick: () => choose(i)
      }, [
        h("span", { className: "quiz-key", text: String.fromCharCode(65 + i) }),
        h("span", { className: "quiz-option-text", html: Markdown.renderInline(option) }),
        h("span", { className: "quiz-mark", "aria-hidden": "true" })
      ])
    );

    function paintAnswer(animate) {
      const chosen = quiz.responses[quiz.index];
      const correct = chosen === q.answer;
      optionButtons.forEach((btn, i) => {
        btn.disabled = true;
        btn.classList.toggle("is-correct", i === q.answer);
        btn.classList.toggle("is-wrong", i === chosen && !correct);
        btn.classList.toggle("is-dim", i !== q.answer && i !== chosen);
        if (animate && i === chosen) btn.classList.add(correct ? "pop" : "shake");
      });
      feedback.replaceChildren(
        h("p", { className: "quiz-verdict " + (correct ? "good" : "bad") }, [
          icon(correct ? "check" : "x"),
          h("span", { text: correct ? "Correct!" : "Not quite - the answer is " + String.fromCharCode(65 + q.answer) + "." })
        ]),
        q.explanation ? h("p", { className: "quiz-explanation", html: Markdown.renderInline(q.explanation) }) : null
      );
      feedback.classList.add("is-open");
      nextBtn.disabled = false;
      scoreBadge.textContent = quizScore(quiz) + " correct";
    }

    function choose(i) {
      if (quiz.responses[quiz.index] !== null) return;
      quiz.responses[quiz.index] = i;
      actions.changed();
      paintAnswer(true);
      nextBtn.focus({ preventScroll: true });
    }

    const scoreBadge = h("span", { className: "quiz-score", text: quizScore(quiz) + " correct" });
    const node = h("div", { className: "quiz" }, [
      h("div", { className: "quiz-top" }, [
        h("span", { className: "quiz-count", text: "Question " + (quiz.index + 1) + " of " + total }),
        scoreBadge
      ]),
      h("div", { className: "meter" }, h("span", { style: "width:" + ((quiz.index + (answered ? 1 : 0)) / total) * 100 + "%" })),
      h("div", { className: "quiz-card slide-in" }, [
        h("p", { className: "quiz-question", html: Markdown.renderInline(q.question) }),
        h("div", { className: "quiz-options" }, optionButtons),
        feedback
      ]),
      h("div", { className: "quiz-nav" }, [
        h("button", {
          type: "button",
          className: "btn btn-ghost",
          disabled: quiz.index === 0,
          onClick: () => {
            quiz.index -= 1;
            actions.changed();
            renderQuiz(actions.container(), quiz, actions);
          }
        }, [icon("chevron-left"), h("span", { text: "Back" })]),
        h("span", { className: "kbd-hint", text: answered ? "Enter ↵ next" : "Press A-" + String.fromCharCode(64 + q.options.length) }),
        nextBtn
      ])
    ]);

    if (answered) paintAnswer(false);
    return node;
  }

  function quizResults(quiz, actions) {
    const total = quiz.questions.length;
    const score = quizScore(quiz);
    const pct = Math.round((score / total) * 100);
    const missed = quiz.questions.map((q, i) => i).filter((i) => quiz.responses[i] !== quiz.questions[i].answer);
    const message =
      pct === 100 ? "Perfect score - you've mastered this!" :
      pct >= 80 ? "Great job! Just a few things to polish." :
      pct >= 60 ? "Good effort. Review the ones you missed and try again." :
      "Keep going - review the explanations below, then retry the missed questions.";

    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const ring = h("div", { className: "score-ring" });
    ring.innerHTML =
      '<svg viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="score-track" cx="60" cy="60" r="' + radius + '"></circle>' +
      '<circle class="score-fill" cx="60" cy="60" r="' + radius + '" stroke-dasharray="' + circumference +
      '" stroke-dashoffset="' + circumference + '"></circle></svg>' +
      '<div class="score-text"><strong class="score-number">0%</strong><span>' + score + " / " + total + "</span></div>";

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const fill = ring.querySelector(".score-fill");
        fill.style.strokeDashoffset = String(circumference * (1 - score / total));
        fill.classList.toggle("is-good", pct >= 80);
        fill.classList.toggle("is-ok", pct >= 50 && pct < 80);
        countUp(ring.querySelector(".score-number"), pct);
      })
    );
    if (pct >= 80) setTimeout(celebrate, 450);

    let nextCount = (quiz.meta && quiz.meta.count) || actions.settings().quizQuestionCount;
    let nextDifficulty = (quiz.meta && quiz.meta.difficulty) || actions.settings().quizDifficulty;

    const review = h("ol", { className: "quiz-review" }, quiz.questions.map((q, i) => {
      const chosen = quiz.responses[i];
      const right = chosen === q.answer;
      return h("li", { className: right ? "right" : "wrong" }, [
        h("p", { className: "review-q", html: Markdown.renderInline(q.question) }),
        h("p", { className: "review-a" }, [
          icon(right ? "check" : "x"),
          h("span", { html: "Your answer: " + (chosen === null ? "<em>skipped</em>" : Markdown.renderInline(q.options[chosen])) })
        ]),
        right ? null : h("p", { className: "review-a correct" }, [icon("check"), h("span", { html: "Correct: " + Markdown.renderInline(q.options[q.answer]) })]),
        q.explanation ? h("p", { className: "review-why", html: Markdown.renderInline(q.explanation) }) : null
      ]);
    }));

    return h("div", { className: "quiz-results slide-in" }, [
      ring,
      h("p", { className: "score-message", text: message }),
      h("div", { className: "quiz-actions" }, [
        h("button", {
          type: "button",
          className: "btn btn-secondary",
          onClick: () => {
            quiz.responses = quiz.questions.map(() => null);
            quiz.index = 0;
            quiz.finished = false;
            actions.changed();
            renderQuiz(actions.container(), quiz, actions);
          }
        }, [icon("refresh"), h("span", { text: "Retake" })]),
        missed.length && missed.length < total
          ? h("button", {
              type: "button",
              className: "btn btn-primary",
              onClick: () => actions.replace(createQuiz(missed.map((i) => quiz.questions[i]), { ...quiz.meta, retry: true }))
            }, [icon("target"), h("span", { text: "Retry " + missed.length + " missed" })])
          : null
      ]),
      h("div", { className: "new-set" }, [
        h("p", { className: "field-label", text: "Make a new quiz" }),
        pills(QUIZ_COUNTS.map((n) => ({ id: n, label: n + " Qs" })), nextCount, (v) => (nextCount = v), "Number of questions"),
        pills(QUIZ_DIFFICULTIES, nextDifficulty, (v) => (nextDifficulty = v), "Difficulty"),
        h("button", {
          type: "button",
          className: "btn btn-secondary btn-full",
          onClick: () => actions.generate({ count: nextCount, difficulty: nextDifficulty })
        }, [icon("sparkles"), h("span", { text: "Generate new quiz" })])
      ]),
      h("h3", { className: "review-title", text: "Review your answers" }),
      review
    ]);
  }

  function countUp(node, target) {
    if (prefersReducedMotion()) {
      node.textContent = target + "%";
      return;
    }
    const start = performance.now();
    const duration = 900;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      node.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))) + "%";
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function handleQuizKey(event, container) {
    const key = event.key;
    const options = Array.from(container.querySelectorAll(".quiz-option"));
    if (!options.length) return false;
    const letter = key.length === 1 ? key.toUpperCase().charCodeAt(0) - 65 : -1;
    const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
    const pick = letter >= 0 && letter < options.length ? letter : digit >= 0 && digit < options.length ? digit : -1;
    if (pick >= 0 && !options[pick].disabled) {
      options[pick].click();
      return true;
    }
    if (key === "Enter" || key === "ArrowRight") {
      const next = container.querySelector(".quiz-nav .btn-primary");
      if (next && !next.disabled) {
        next.click();
        return true;
      }
    }
    if (key === "ArrowLeft") {
      const back = container.querySelector(".quiz-nav .btn-ghost");
      if (back && !back.disabled) {
        back.click();
        return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   *  Flashcards
   * ---------------------------------------------------------------- */

  function createDeck(cards, meta) {
    return {
      cards,
      order: cards.map((_, i) => i),
      position: 0,
      flipped: false,
      known: cards.map(() => false),
      onlyLearning: false,
      meta: meta || {}
    };
  }

  function visibleCards(deck) {
    return deck.onlyLearning ? deck.order.filter((i) => !deck.known[i]) : deck.order;
  }

  function renderFlashcards(container, deck, actions, direction) {
    const visible = visibleCards(deck);
    const knownCount = deck.known.filter(Boolean).length;
    const total = deck.cards.length;
    if (deck.position >= visible.length) deck.position = Math.max(0, visible.length - 1);

    const top = h("div", { className: "fc-top" }, [
      h("span", { className: "fc-count", text: visible.length ? "Card " + (deck.position + 1) + " of " + visible.length + (deck.onlyLearning ? " (still learning)" : "") : "All done" }),
      h("span", { className: "fc-known" }, [icon("check"), h("span", { text: knownCount + " / " + total + " known" })])
    ]);
    const meter = h("div", { className: "meter meter-good" }, h("span", { style: "width:" + (knownCount / total) * 100 + "%" }));

    const rerender = (dir) => {
      actions.changed();
      renderFlashcards(actions.container(), deck, actions, dir);
    };

    let stage;
    if (!visible.length) {
      stage = h("div", { className: "fc-done slide-in" }, [
        h("div", { className: "fc-done-icon" }, icon("trophy")),
        h("p", { className: "fc-done-title", text: "You know all " + total + " cards!" }),
        h("p", { className: "hint", text: "Run through the whole deck again, or make a new set." }),
        h("button", {
          type: "button",
          className: "btn btn-primary",
          onClick: () => {
            deck.known = deck.cards.map(() => false);
            deck.onlyLearning = false;
            deck.position = 0;
            deck.flipped = false;
            rerender();
          }
        }, [icon("refresh"), h("span", { text: "Study again" })])
      ]);
      if (direction === "complete") setTimeout(celebrate, 200);
    } else {
      const cardIndex = visible[deck.position];
      const card = deck.cards[cardIndex];
      const isKnown = deck.known[cardIndex];
      const flashcard = h("button", {
        type: "button",
        className: "flashcard" + (deck.flipped ? " is-flipped" : "") + (direction ? " enter-" + direction : ""),
        "aria-label": deck.flipped ? "Answer shown. Click to show the question." : "Question shown. Click to reveal the answer.",
        onClick: () => {
          deck.flipped = !deck.flipped;
          flashcard.classList.toggle("is-flipped", deck.flipped);
          actions.changed();
        }
      }, h("span", { className: "fc-inner" }, [
        h("span", { className: "fc-face fc-front" }, [
          h("span", { className: "fc-label", text: isKnown ? "Term · known" : "Term" }),
          h("span", { className: "fc-text", html: Markdown.renderInline(card.front) }),
          h("span", { className: "fc-hint" }, [icon("refresh"), h("span", { text: "Tap to flip" })])
        ]),
        h("span", { className: "fc-face fc-back" }, [
          h("span", { className: "fc-label", text: "Answer" }),
          h("span", { className: "fc-text", html: Markdown.renderInline(card.back) })
        ])
      ]));

      const move = (delta) => {
        const count = visibleCards(deck).length;
        if (!count) return;
        deck.position = (deck.position + delta + count) % count;
        deck.flipped = false;
        rerender(delta > 0 ? "right" : "left");
      };
      const mark = (known) => {
        deck.known[cardIndex] = known;
        deck.flipped = false;
        const remaining = visibleCards(deck);
        if (!remaining.length) return rerender("complete");
        // In "still learning" mode a known card leaves the list, so the
        // next card is already at this position.
        if (!(deck.onlyLearning && known)) deck.position = (deck.position + 1) % remaining.length;
        rerender("right");
      };

      stage = h("div", { className: "fc-stage" }, [
        flashcard,
        h("div", { className: "fc-controls" }, [
          h("button", { type: "button", className: "icon-btn", "aria-label": "Previous card", title: "Previous (←)", onClick: () => move(-1) }, icon("chevron-left")),
          h("button", { type: "button", className: "btn btn-secondary fc-learning", title: "Still learning (1)", onClick: () => mark(false) }, h("span", { text: "Still learning" })),
          h("button", { type: "button", className: "btn btn-primary fc-gotit", title: "Got it (2)", onClick: () => mark(true) }, [icon("check"), h("span", { text: "Got it" })]),
          h("button", { type: "button", className: "icon-btn", "aria-label": "Next card", title: "Next (→)", onClick: () => move(1) }, icon("chevron-right"))
        ]),
        h("p", { className: "kbd-hint center", text: "Space to flip · ← → to move · 1 still learning · 2 got it" })
      ]);
    }

    const learningCount = total - knownCount;
    const tools = h("div", { className: "fc-tools" }, [
      h("button", {
        type: "button",
        className: "btn btn-ghost btn-small",
        onClick: () => {
          for (let i = deck.order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck.order[i], deck.order[j]] = [deck.order[j], deck.order[i]];
          }
          deck.position = 0;
          deck.flipped = false;
          rerender("right");
          actions.toast("Deck shuffled");
        }
      }, [icon("shuffle"), h("span", { text: "Shuffle" })]),
      h("button", {
        type: "button",
        className: "btn btn-ghost btn-small" + (deck.onlyLearning ? " is-active" : ""),
        "aria-pressed": String(deck.onlyLearning),
        disabled: !deck.onlyLearning && (learningCount === 0 || learningCount === total),
        onClick: () => {
          deck.onlyLearning = !deck.onlyLearning;
          deck.position = 0;
          deck.flipped = false;
          rerender("right");
        }
      }, [icon("target"), h("span", { text: deck.onlyLearning ? "Show all cards" : "Still learning only (" + learningCount + ")" })]),
      h("button", {
        type: "button",
        className: "btn btn-ghost btn-small",
        onClick: () => {
          deck.known = deck.cards.map(() => false);
          deck.order = deck.cards.map((_, i) => i);
          deck.onlyLearning = false;
          deck.position = 0;
          deck.flipped = false;
          rerender("left");
        }
      }, [icon("refresh"), h("span", { text: "Reset" })])
    ]);

    let nextCount = (deck.meta && deck.meta.count) || actions.settings().flashcardCount;
    const newSet = h("div", { className: "new-set" }, [
      h("p", { className: "field-label", text: "Make a new set" }),
      pills(CARD_COUNTS.map((n) => ({ id: n, label: n + " cards" })), nextCount, (v) => (nextCount = v), "Number of cards"),
      h("button", {
        type: "button",
        className: "btn btn-secondary btn-full",
        onClick: () => actions.generate({ count: nextCount })
      }, [icon("sparkles"), h("span", { text: "Generate new flashcards" })])
    ]);

    container.replaceChildren(h("div", { className: "fc" }, [top, meter, stage, tools, newSet]));
  }

  function handleFlashcardKey(event, container) {
    const key = event.key;
    const click = (selector) => {
      const btn = container.querySelector(selector);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      return false;
    };
    if (key === " " || key === "Enter") return click(".flashcard");
    if (key === "ArrowRight") return click('.fc-controls [aria-label="Next card"]');
    if (key === "ArrowLeft") return click('.fc-controls [aria-label="Previous card"]');
    if (key === "1") return click(".fc-learning");
    if (key === "2") return click(".fc-gotit");
    return false;
  }

  /* ---------------------------------------------------------------- *
   *  Export helpers
   * ---------------------------------------------------------------- */

  function quizToMarkdown(quiz, title) {
    const lines = ["# Quiz: " + title, ""];
    quiz.questions.forEach((q, i) => {
      lines.push(i + 1 + ". " + q.question);
      q.options.forEach((o, j) => lines.push("   " + String.fromCharCode(65 + j) + ") " + o));
      lines.push("");
    });
    lines.push("## Answer Key", "");
    quiz.questions.forEach((q, i) => {
      lines.push(i + 1 + ". **" + String.fromCharCode(65 + q.answer) + "** - " + q.options[q.answer] + (q.explanation ? " — " + q.explanation : ""));
    });
    return lines.join("\n");
  }

  function deckToMarkdown(deck, title) {
    return ["# Flashcards: " + title, ""]
      .concat(deck.cards.map((c, i) => i + 1 + ". **" + c.front + "** — " + c.back))
      .join("\n");
  }

  // Tab-separated "front<TAB>back" lines import directly into Anki and Quizlet.
  function deckToTSV(deck) {
    const clean = (s) => String(s).replace(/[\t\r\n]+/g, " ").trim();
    return deck.cards.map((c) => clean(c.front) + "\t" + clean(c.back)).join("\n");
  }

  return {
    createQuiz,
    renderQuiz,
    handleQuizKey,
    quizScore,
    createDeck,
    renderFlashcards,
    handleFlashcardKey,
    quizToMarkdown,
    deckToMarkdown,
    deckToTSV,
    celebrate
  };
})();
