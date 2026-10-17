// Saying an answer while it is still being written.
//
// The text arrives in pieces. What is whole already (whole lines, whole
// sentences, outside code) is cut off and handed on at once; the rest waits
// for more. A piece in plain Russian goes to the voice as it is. One with
// Latin, digits or symbols is retold by the model first, one retelling at a
// time: what is written meanwhile goes into the next one, so the model is
// asked a few times per answer, not once per sentence. Whatever the order
// they get ready in, the pieces are said in the order they were written.

import { FULL_PIECE, cleanForSpeech, isSpeakable, readyCut } from './speech'

/** What the window made of a piece: said, or the voice is shut for this answer. */
export type Heard = 'said' | 'muted' | 'gone'

export type Voice = {
  /** The next piece of the text as it streams. */
  write: (text: string) => void
  /** The text so far is all there is: the rest is said, however it ends. */
  end: () => void
  /** Drops what is not said yet; nothing more is said. */
  hush: () => void
  /** Settles once everything handed on has been said or dropped. */
  said: () => Promise<void>
}

export function createVoice(
  retell: (plain: string) => Promise<string>,
  say: (text: string) => Promise<Heard>,
): Voice {
  let written = ''
  let waiting = ''
  let retellings = 0
  let isHushed = false
  let line: Promise<void> = Promise.resolve()

  const handOn = (isLast: boolean): void => {
    if (isHushed || !waiting) return
    if (retellings > 0 && !isLast && waiting.length < FULL_PIECE) return
    const plain = waiting
    waiting = ''
    const words = isSpeakable(plain) ? Promise.resolve(plain) : retold(plain)
    line = line.then(async () => {
      const text = await words
      if (isHushed || !text) return
      if ((await say(text)) !== 'said') isHushed = true
    })
  }

  const retold = (plain: string): Promise<string> => {
    retellings += 1
    return retell(plain)
      .catch(() => '')
      .finally(() => {
        retellings -= 1
        handOn(false)
      })
  }

  const keep = (raw: string): void => {
    const plain = cleanForSpeech(raw)
    if (plain) waiting = waiting ? `${waiting}\n${plain}` : plain
  }

  return {
    write: text => {
      written += text
      const cut = readyCut(written)
      if (cut === 0) return
      keep(written.slice(0, cut))
      written = written.slice(cut)
      handOn(false)
    },
    end: () => {
      keep(written)
      written = ''
      handOn(true)
    },
    hush: () => {
      isHushed = true
      written = ''
      waiting = ''
    },
    said: () => line,
  }
}
