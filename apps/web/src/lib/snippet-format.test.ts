import { EMPTY_SNIPPET_FALLBACK, formatSnippet } from './snippet-format'

describe('formatSnippet', () => {
  it('removes category/include/heading/wiki-link artifacts', () => {
    const raw =
      '[[분류:나무위키 Roblox 프로젝트]][[분류:Bee Swarm Simulator]] [include(틀:상위 문서, top1=Bee Swarm Simulator)] [목차] == 개요 == [[Roblox]]의 [[Bee Swarm Simulator]] 의 몹에 관한 문서이다. == 퀘스트를 주는 몹 == 곰들은 대부분 퀘스트를 준다.'

    const formatted = formatSnippet(raw)

    expect(formatted).toContain('개요')
    expect(formatted).toContain('Roblox의 Bee Swarm Simulator 의 몹에 관한 문서이다.')
    expect(formatted).toContain('퀘스트를 주는 몹')
    expect(formatted).not.toContain('분류:')
    expect(formatted).not.toContain('include(')
    expect(formatted).not.toContain('[[')
    expect(formatted).not.toContain(']]')
  })

  it('returns fallback when snippet is table/file artifact only', () => {
    const raw =
      '||<-2><tablewidth=350><tablealign=right><tablebordercolor=#2e2e2e> [[파일:eggfarmsimulator.png]] || ||<-2> [[https://www.roblox.com/games/1828509885/AUTO-EGGS-Egg-Farm-Simulator|[[파일:play.png|width=170]]]] || ||<width=50%><bgcolor=#2e2e2e> {{'

    expect(formatSnippet(raw)).toBe(EMPTY_SNIPPET_FALLBACK)
  })
})
