// Shows suggested on first launch and in Discover. Covers and feeds are fixed here so the page needs no lookups.
export type Topic = "AI 前沿" | "AI 工程" | "创业投资" | "产品与增长" | "科技评论" | "中文播客";
export const TOPICS: Topic[] = ["AI 前沿", "AI 工程", "创业投资", "产品与增长", "科技评论", "中文播客"];

export interface Pick { id: string; title: string; zh: string; by: string; intro: string; input: string; cover: string; topics: Topic[]; video?: boolean }

const it = (path: string) => `https://is1-ssl.mzstatic.com/image/thumb/${path}/600x600bb.jpg`;

export const PICKS: Pick[] = [
  { id: "dwarkesh", title: "Dwarkesh Podcast", zh: "Dwarkesh 播客", by: "Dwarkesh Patel", intro: "深度访谈 AI 实验室负责人与顶尖研究者，硬核又好懂", input: "https://www.youtube.com/@DwarkeshPatel", cover: it("Podcasts211/v4/af/6f/48/af6f4828-86a2-d4c3-b998-de2af1fdc8c0/mza_949624848217027907.jpg"), topics: ["AI 前沿"], video: true },
  { id: "no-priors", title: "No Priors", zh: "无先验", by: "Sarah Guo & Elad Gil", intro: "两位顶级投资人对话 AI 公司创始人", input: "https://feeds.megaphone.fm/nopriors", cover: it("Podcasts221/v4/8f/46/88/8f4688ec-087f-28a1-7f6d-0d401d2e8a00/mza_14043856542292072583.jpg"), topics: ["AI 前沿", "创业投资"] },
  { id: "lex", title: "Lex Fridman Podcast", zh: "Lex Fridman 播客", by: "Lex Fridman", intro: "科技、科学与人物的长篇对谈", input: "https://www.youtube.com/@lexfridman", cover: it("Podcasts211/v4/ea/42/d7/ea42d7b1-8d4e-dd97-da5d-c508756550ca/mza_16782152345430036863.jpg"), topics: ["科技评论", "AI 前沿"], video: true },
  { id: "cognitive", title: "The Cognitive Revolution", zh: "认知革命", by: "Nathan Labenz", intro: "每周拆解最新 AI 进展与应用", input: "https://feeds.megaphone.fm/RINTP3108857801", cover: it("Podcasts211/v4/b1/29/0d/b1290dd6-516c-bc2d-53b6-473d18a3dff2/mza_6540782963388625071.jpeg"), topics: ["AI 前沿"] },
  { id: "ai-daily", title: "The AI Daily Brief", zh: "AI 每日简报", by: "Nathaniel Whittemore", intro: "每天 20 分钟，跟上 AI 新闻", input: "https://anchor.fm/s/f7cac464/podcast/rss", cover: it("Podcasts211/v4/9c/78/d8/9c78d82d-a2d1-a026-6ca2-f92ea61be9ae/mza_18421328158594577747.jpg"), topics: ["AI 前沿"] },
  { id: "latent-space", title: "Latent Space", zh: "潜空间", by: "swyx & Alessio", intro: "写给 AI 工程师的一线实践与工具", input: "https://podcast.latent.space/feed.xml", cover: it("Podcasts221/v4/5c/7d/2a/5c7d2ade-4458-04e8-9838-979d187712ed/mza_16100858243175777898.jpg"), topics: ["AI 工程"] },
  { id: "training-data", title: "Training Data", zh: "训练数据", by: "Sequoia Capital", intro: "红杉资本对话 AI 创业者", input: "https://feeds.megaphone.fm/trainingdata", cover: it("Podcasts221/v4/40/01/bd/4001bd05-9453-3d7f-c034-d815c74d332d/mza_6464974713460854089.png"), topics: ["创业投资", "AI 工程"] },
  { id: "yc", title: "Y Combinator", zh: "Y Combinator", by: "YC", intro: "全球顶级孵化器的创业课与创始人访谈", input: "https://www.youtube.com/@ycombinator", cover: it("Podcasts221/v4/65/d1/1e/65d11ed6-914f-e163-bc7a-d1ea5eda5b79/mza_2184580866640883071.jpg"), topics: ["创业投资"], video: true },
  { id: "a16z", title: "The a16z Show", zh: "a16z 播客", by: "Andreessen Horowitz", intro: "硅谷头部基金看科技与未来", input: "https://feeds.simplecast.com/JGE3yC0V", cover: it("Podcasts221/v4/3e/04/91/3e049169-5b95-784c-2197-01cfff9f41eb/mza_10026788811025472218.jpg"), topics: ["创业投资", "科技评论"] },
  { id: "20vc", title: "The Twenty Minute VC", zh: "20 分钟 VC", by: "Harry Stebbings", intro: "风投与创业者的快节奏对话", input: "https://rss.libsyn.com/shows/61840/destinations/240976.xml", cover: it("Podcasts221/v4/cb/4a/f9/cb4af9a2-5857-c3f1-30d4-14395af9a14f/mza_11350890235230424535.jpeg"), topics: ["创业投资"] },
  { id: "lenny", title: "Lenny's Podcast", zh: "Lenny 播客", by: "Lenny Rachitsky", intro: "产品、增长与职业成长的实战经验", input: "https://api.substack.com/feed/podcast/10845.rss", cover: it("Podcasts211/v4/c7/80/a3/c780a365-a1ed-527f-365f-1bd3e51ac6d1/mza_5908526734339724450.jpg"), topics: ["产品与增长"] },
  { id: "acquired", title: "Acquired", zh: "收购", by: "Ben Gilbert & David Rosenthal", intro: "讲透一家伟大公司的完整故事", input: "https://feeds.transistor.fm/acquired", cover: it("Podcasts211/v4/a8/e1/de/a8e1deff-9f88-4e55-a541-b0dc793c0cdc/mza_11539673419613154037.jpg"), topics: ["科技评论", "创业投资"] },
  { id: "hard-fork", title: "Hard Fork", zh: "硬分叉", by: "The New York Times", intro: "《纽约时报》每周科技评论", input: "https://feeds.simplecast.com/6HKOhNgS", cover: it("Podcasts221/v4/de/c5/20/dec52092-6be0-9007-875c-6aa8e690a905/mza_12490014444602578825.jpg"), topics: ["科技评论"] },
  { id: "decoder", title: "Decoder with Nilay Patel", zh: "解码者", by: "The Verge", intro: "与 CEO 们聊组织、决策与科技产业", input: "https://feeds.megaphone.fm/recodedecode", cover: it("Podcasts211/v4/45/b2/ea/45b2ea67-03e4-2eb9-b333-fdcd9ead3f80/mza_1465024791640209731.jpg"), topics: ["科技评论", "产品与增长"] },
  { id: "zhang", title: "张小珺Jùn｜商业访谈录", zh: "张小珺｜商业访谈录", by: "张小珺", intro: "与中国科技、商业一线人物的长访谈", input: "https://feed.xyzfm.space/dk4yh3pkpjp3", cover: it("Podcasts221/v4/e6/74/44/e674449c-c2ac-50c4-0099-7e37c330e6c5/mza_16442776193352459849.png"), topics: ["中文播客", "AI 前沿"] },
  { id: "sv101", title: "硅谷101", zh: "硅谷101", by: "泓君", intro: "硅谷科技、创业与人物的深度访谈", input: "https://feeds.fireside.fm/sv101/rss", cover: it("Podcasts126/v4/96/d6/82/96d682e0-e42f-d8bf-68c3-c18ff9c20c8f/mza_15727650922171364471.jpg"), topics: ["中文播客", "科技评论"] },
  { id: "latetalk", title: "晚点聊 LateTalk", zh: "晚点聊 LateTalk", by: "晚点 LatePost", intro: "《晚点》记者与创业者、投资人的对话", input: "https://feeds.fireside.fm/latetalk/rss", cover: it("Podcasts211/v4/79/f3/66/79f366d3-dfb2-4c6e-ade6-e95e18261c4f/mza_6811336372335437524.jpg"), topics: ["中文播客", "创业投资"] },
  { id: "42", title: "42章经", zh: "42章经", by: "曲凯", intro: "创投圈的思考与方法论", input: "https://feed.xyzfm.space/evgg6xle9rdc", cover: it("Podcasts126/v4/33/6c/3f/336c3fea-4e5a-9524-6b7d-92c1080a6db9/mza_9247514814536235437.png"), topics: ["中文播客", "创业投资"] },
  { id: "banlatie", title: "半拿铁 | 商业沉浮录", zh: "半拿铁｜商业沉浮录", by: "潇磊 & 刘飞", intro: "轻松好听的商业故事", input: "https://proxy.wavpub.com/caffebreve.xml", cover: it("Podcasts112/v4/95/33/4d/95334de1-1492-1ab0-aa7b-8f246bf89bde/mza_10728614257690800956.jpeg"), topics: ["中文播客"] },
];

/** The first part of a long show name: "No Priors: Artificial Intelligence | …" → "No Priors". */
export function shortName(title: string): string {
  const s = title.split(/\s*(?:[:：|｜—–]|\s-\s)\s*/)[0].replace(/^["“]|["”]$/g, "").trim();
  return s.length >= 2 ? s : title;
}

/** A show's display name: our curated Chinese name when we have one, else its own short name. Names are proper
 *  nouns, so they are never machine-translated (Google turns "Dwarkesh Patel" into a transliteration). */
export function showName(title: string): string {
  const short = shortName(title);
  const p = PICKS.find((x) => x.title === title || shortName(x.title) === short || x.by === title);
  return p?.zh ?? short;
}
