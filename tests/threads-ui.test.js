import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const accountService = fs.readFileSync(new URL("../src/services/account-service.js", import.meta.url), "utf8");

test("Threads view renders every active task and refreshes only while visible without overlapping probes", () => {
  for (const id of ["threads-nav", "threads-view", "threads-active-list", "threads-active-count", "threads-search", "threads-search-results"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function renderThreadsActivity\(/);
  assert.match(app, /function startThreadsActivityRefresh\(/);
  assert.match(app, /function stopThreadsActivityRefresh\(/);
  assert.match(app, /threadActivityIntervalMs\s*=\s*2_000/);
  assert.match(app, /setInterval\(refreshThreadsActivity, threadActivityIntervalMs\)/);
  assert.match(app, /let threadActivityRefreshInFlight = false;/);
  const activityRefresh = app.slice(app.indexOf("async function refreshThreadsActivity()"), app.indexOf("function renderThreadsActivity()"));
  const guard = 'if (currentView !== "threads" || threadActivityRefreshInFlight) return;';
  assert.match(activityRefresh, /if \(currentView !== "threads" \|\| threadActivityRefreshInFlight\) return;/);
  assert.match(activityRefresh, /threadActivityRefreshInFlight = true;/);
  assert.ok(activityRefresh.indexOf(guard) < activityRefresh.indexOf("++threadActivityRequestId"));
  assert.match(activityRefresh, /finally\s*{\s*threadActivityRefreshInFlight = false;\s*}/);
  assert.match(app, /activeTasks\.forEach/);
  assert.match(app, /threadsActiveList\.replaceChildren/);
  const threadRenderer = app.slice(app.indexOf("function renderThreadsActivity()"), app.indexOf("function renderThreadSearchResults("));
  assert.doesNotMatch(threadRenderer, /\.slice\(/);
});

test("Threads view has its own readable rows and keeps all five navigation items on narrow screens", () => {
  assert.match(css, /\.threads-view\b/);
  assert.match(css, /\.thread-row\b/);
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.nav-stack\s*{[^}]*grid-template-columns:\s*repeat\(5,/s);
});

test("responsive main accounts view releases viewport clipping into one page scroll flow", () => {
  assert.match(css, /\.accounts-view\s*{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/s);
  assert.match(
    css,
    /@media \(max-width:\s*980px\)[\s\S]*?\.app-shell,\s*\.workspace,\s*\.accounts-view,\s*\.accounts-workspace,\s*\.metrics-strip\s*{[^}]*height:\s*auto;/s
  );
  assert.match(
    css,
    /@media \(max-width:\s*980px\)[\s\S]*?\.accounts-view\s*{[^}]*grid-template-rows:\s*auto auto auto;[^}]*overflow:\s*visible;/s
  );
  assert.match(
    css,
    /@media \(max-width:\s*980px\)[\s\S]*?\.list-panel,\s*\.detail-panel\s*{[^}]*overflow:\s*visible;/s
  );
});

test("Threads view reports conservative indexing and incrementally renders grouped metadata", () => {
  assert.match(main, /"app:getCodexActivityStatus": \(\) => accountService\.getCodexActivityStatusForThreads\(\)/);
  assert.match(app, /threads\.activityIndexing/);
  const activityRenderer = app.slice(app.indexOf("function renderThreadsActivity()"), app.indexOf("function renderThreadSearchResults("));
  assert.match(activityRenderer, /threadActivityStatus\?\.isBusy && !threadActivityStatus\?\.activityIndexing/);
  assert.match(app, /threadGroupPageSize\s*=\s*10/);
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /groupThreadSearchResults\(threads\)/);
  assert.match(searchRenderer, /createThreadGroup\(/);
  assert.match(app, /visibleCount \+ threadGroupPageSize/);
});

test("Threads page loads recent persistent threads for an empty query and labels activity as executing tasks", () => {
  const showView = app.slice(app.indexOf("function showView(view)"), app.indexOf("function applyTheme()"));
  const queueSearch = app.slice(app.indexOf("function queueThreadSearch()"), app.indexOf("async function searchLocalThreads("));
  assert.match(showView, /if \(showingThreads\)[\s\S]*?queueThreadSearch\(\)/);
  assert.doesNotMatch(queueSearch, /if \(!query\)[\s\S]*?threadSearchResults\s*=\s*\[\]/);
  assert.match(queueSearch, /searchLocalThreads\(query,\s*requestId\)/);
  assert.match(app, /"threads\.active":\s*"正在执行的任务"/);
  assert.match(app, /"threads\.activeCount":\s*"执行中 \{count\}"/);
  assert.match(app, /"threads\.noActive":\s*"目前没有正在执行的任务。闲置或等待输入的线程不计入这里。"/);
  assert.match(app, /"threads\.searchPrompt":\s*"显示最近更新的本机线程。"/);
  assert.match(app, /"threads\.active":\s*"Executing tasks"/);
});

test("thread search IPC is path-free and copy uses the selected stable ID", () => {
  assert.match(preload, /searchLocalCodexThreads:\s*\(query\)\s*=>\s*invoke\("threads:searchLocal",\s*typeof query === "string" \? query : ""\)/);
  assert.match(main, /"threads:searchLocal":\s*\(_event, query\)\s*=>\s*accountService\.searchLocalCodexThreads\(query\)/);
  assert.match(app, /api\.searchLocalCodexThreads\(query\)/);
  assert.match(app, /function copyThreadId\(id\)/);
  assert.match(app, /navigator\.clipboard\.writeText\(id\)/);
  assert.doesNotMatch(app, /shell\.openExternal\([^\n]*thread/);
});

test("thread cards distinguish registered projects from normalized task directories", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /thread\?\.category === "temporary_executor"/);
  assert.match(searchRenderer, /thread\?\.projectName/);
  assert.match(searchRenderer, /thread\?\.workspacePath/);
  assert.match(searchRenderer, /label: t\("threads\.workspace"\), value: thread\?\.workspacePath/);
  assert.match(app, /"threads\.project":\s*"所属项目"/);
  assert.match(app, /"threads\.workspace":\s*"任务目录"/);
  assert.match(app, /"threads\.unregisteredProject":\s*"未登记项目"/);
  assert.match(app, /"threads\.project":\s*"Project"/);
  assert.match(app, /"threads\.workspace":\s*"Task directory"/);
});

test("thread groups are newest-first, collapsed by default, and searches open matching groups", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /latestUpdatedAtMs/);
  assert.match(searchRenderer, /\.sort\(\(left, right\) => right\.latestUpdatedAtMs - left\.latestUpdatedAtMs/);
  assert.match(searchRenderer, /groupElement\.open = Boolean\(threadsSearch\.value\.trim\(\)\)/);
  assert.match(searchRenderer, /t\("threads\.groupSummary",\s*{\s*count: group\.threads\.length/);
  assert.match(searchRenderer, /t\("threads\.showMore"/);
  assert.match(css, /\.thread-group\b/);
  assert.match(css, /\.thread-group-summary\b/);
});

test("temporary executor rows use a localized readable title", () => {
  assert.match(app, /thread\?\.category === "temporary_executor"\s*\?\s*t\("threads\.temporaryExecutorTitle"\)/);
  assert.match(app, /"threads\.temporaryGroup":\s*"临时执行器与自动化任务"/);
  assert.match(app, /"threads\.temporaryExecutorTitle":\s*"AgentBridge 临时执行器任务"/);
  assert.match(app, /"threads\.temporaryGroup":\s*"Temporary executors and automation"/);
});

test("ordinary archived threads are hidden by default and restored without another metadata query", () => {
  assert.match(html, /<input id="threads-show-archived" type="checkbox"\s*\/>/);
  assert.doesNotMatch(html, /<input id="threads-show-archived"[^>]*\bchecked\b/);
  assert.match(app, /const threadsShowArchived = document\.querySelector\("#threads-show-archived"\)/);
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /const archivedThreads = allThreads\.filter\(\(thread\) => thread\?\.archived\)/);
  assert.match(searchRenderer, /threadsShowArchived\.checked\s*\?\s*allThreads\s*:\s*allThreads\.filter\(\(thread\) => !thread\?\.archived \|\| Number\.isFinite\(thread\?\.pinnedIndex\)\)/);
  assert.match(searchRenderer, /threads\.archivedSearchOnly/);
  const archiveToggle = app.slice(
    app.indexOf('threadsShowArchived.addEventListener("change"'),
    app.indexOf('threadsShowArchived.addEventListener("change"') + 320
  );
  assert.match(archiveToggle, /renderThreadSearchResults\(threadSearchResults\)/);
  assert.doesNotMatch(archiveToggle, /searchLocalThreads|api\./);
});

test("archived thread visibility and hidden counts are bilingual", () => {
  assert.match(app, /"threads\.showArchived":\s*"显示已归档"/);
  assert.match(app, /"threads\.searchResultCountWithHidden":\s*"显示 \{count\} 条未归档线程，已隐藏 \{hidden\} 条归档线程。"/);
  assert.match(app, /"threads\.archivedSearchOnly":\s*"匹配结果仅存在于已归档线程；启用“显示已归档”即可查看。"/);
  assert.match(app, /"threads\.showArchived":\s*"Show archived"/);
  assert.match(app, /"threads\.searchResultCountWithHidden":\s*"Showing \{count\} current thread\(s\); \{hidden\} archived thread\(s\) hidden\."/);
  assert.match(css, /\.thread-search-options\b/);
  assert.match(css, /\.thread-archive-toggle\b/);
});

test("persistent threads mirror Codex pin order and collapse spawned child tasks", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /const hierarchy = buildThreadHierarchy\(threads\)/);
  assert.match(searchRenderer, /hierarchy\.pinned\.map\(createThreadSearchRow\)/);
  assert.match(searchRenderer, /groupThreadSearchResults\(ordinaryThreads\)/);
  assert.match(searchRenderer, /thread\?\.parentThreadId/);
  assert.match(searchRenderer, /createThreadChildren\(/);
  assert.match(searchRenderer, /childElement\.open = false/);
  assert.match(app, /"threads\.pinned":\s*"置顶"/);
  assert.match(app, /"threads\.pinnedProject":\s*"项目\/任务文件夹"/);
  assert.match(app, /"threads\.childTasks":\s*"内部子任务 \{count\}"/);
  assert.match(app, /"threads\.pinned":\s*"Pinned"/);
  assert.match(app, /"threads\.pinnedProject":\s*"Project\/task folder"/);
  assert.match(searchRenderer, /thread\?\.entityType === "project"/);
  assert.match(searchRenderer, /!isProject && typeof thread\?\.id/);
  assert.match(searchRenderer, /projectThreads\.get\(thread\.projectId\)/);
  assert.match(searchRenderer, /pinnedUnreadIds/);
  assert.match(searchRenderer, /pinnedUnreadStates/);
  assert.match(searchRenderer, /unreadSummary: isProject \? thread : undefined/);
  assert.match(app, /"threads\.childTasks":\s*"\{count\} internal child task\(s\)"/);
  assert.match(css, /\.thread-pinned-section\b/);
  assert.match(css, /\.thread-children\b/);
});

test("pinned archived threads remain visible while ordinary archived threads stay hidden", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function buildThreadHierarchy("));
  assert.match(searchRenderer, /!thread\?\.archived \|\| Number\.isFinite\(thread\?\.pinnedIndex\)/);
  const resultMessage = app.slice(app.indexOf("function setThreadSearchResultMessage("), app.indexOf("function setThreadSearchMessage("));
  assert.match(resultMessage, /thread\?\.archived && !Number\.isFinite\(thread\?\.pinnedIndex\)/);
});

test("persistent thread rows label lifecycle terminal states without exposing errors", () => {
  const rowRenderer = app.slice(app.indexOf("function createThreadSearchRow("), app.indexOf("function queueThreadSearch()"));
  assert.match(rowRenderer, /threadTurnStateLabel\(thread\?\.turnState,\s*sidebarUnread\)/);
  for (const key of ["running", "completed", "interrupted", "usageLimited", "failed", "unknown"]) {
    assert.match(app, new RegExp(`"threads\\.state\\.${key}"`));
  }
  assert.match(css, /\.thread-state\.is-usage-limited\b/);
  assert.match(css, /\.thread-state\.is-interrupted\b/);
  assert.doesNotMatch(rowRenderer, /thread\?\.error|error\.message/);
});

test("internal tasks are hidden by default and can be explicitly revealed", () => {
  assert.match(html, /<input id="threads-show-internal" type="checkbox"\s*\/>/);
  assert.doesNotMatch(html, /<input id="threads-show-internal"[^>]*\bchecked\b/);
  assert.match(app, /const threadsShowInternal = document\.querySelector\("#threads-show-internal"\)/);
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /threadsShowInternal\.checked/);
  assert.match(searchRenderer, /thread\?\.category === "temporary_executor"/);
  assert.match(searchRenderer, /thread\?\.threadSource === "subagent"/);
  assert.match(app, /"threads\.showInternal":\s*"显示内部任务"/);
  assert.match(app, /"threads\.showInternal":\s*"Show internal tasks"/);
});

test("unregistered ordinary directories are visible by default and filtered from cached results", () => {
  assert.match(html, /<input id="threads-show-unregistered" type="checkbox" checked\s*\/>/);
  assert.match(app, /const threadsShowUnregistered = document\.querySelector\("#threads-show-unregistered"\)/);
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /const ordinaryThreads = threadsShowUnregistered\.checked/);
  assert.match(searchRenderer, /hierarchy\.ordinary\.filter/);
  assert.match(searchRenderer, /thread\?\.projectName \|\| thread\?\.category === "temporary_executor"/);
  assert.match(searchRenderer, /hierarchy\.pinned\.map\(createThreadSearchRow\)/);
  assert.match(app, /"threads\.showUnregistered":\s*"显示未登记目录"/);
  assert.match(app, /"threads\.showUnregistered":\s*"Show unregistered directories"/);
  const toggle = app.slice(
    app.indexOf('threadsShowUnregistered.addEventListener("change"'),
    app.indexOf('threadsShowUnregistered.addEventListener("change"') + 360
  );
  assert.match(toggle, /renderThreadSearchResults\(threadSearchResults\)/);
  assert.doesNotMatch(toggle, /searchLocalThreads|api\./);
});

test("search-only unregistered matches explain how to reveal them", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /threads\.unregisteredSearchOnly/);
  assert.match(app, /"threads\.unregisteredSearchOnly":\s*"匹配结果仅存在于未登记目录；启用“显示未登记目录”即可查看。"/);
  assert.match(app, /"threads\.unregisteredSearchOnly":\s*"Matching records are in unregistered directories; enable “Show unregistered directories” to view them\."/);
});

test("pinned tasks use a persistent native disclosure", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function buildThreadHierarchy("));
  assert.match(searchRenderer, /document\.createElement\("details"\)/);
  assert.match(searchRenderer, /document\.createElement\("summary"\)/);
  assert.match(searchRenderer, /pinnedSectionOpen/);
  assert.match(searchRenderer, /localStorage\.setItem\(THREAD_PINNED_OPEN_KEY/);
});

test("ordinary tasks use a persistent native disclosure with aggregate counts", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function buildThreadHierarchy("));
  assert.match(app, /const THREAD_ORDINARY_OPEN_KEY = "threads-ordinary-open-v1"/);
  assert.match(searchRenderer, /className = "thread-ordinary-section"/);
  assert.match(searchRenderer, /ordinarySectionOpen/);
  assert.match(searchRenderer, /localStorage\.setItem\(THREAD_ORDINARY_OPEN_KEY/);
  assert.match(searchRenderer, /t\("threads\.ordinarySummary",\s*{\s*groups:/);
  assert.match(app, /"threads\.ordinary":\s*"任务"/);
  assert.match(css, /\.thread-ordinary-summary\b/);
});

test("top-level thread disclosures use readable peer headings", () => {
  assert.match(css, /\.thread-pinned-summary strong,[\s\S]*\.thread-ordinary-summary strong[\s\S]*font-size:\s*16px/s);
  assert.match(css, /\.thread-pinned-summary span,[\s\S]*\.thread-ordinary-summary span[\s\S]*font-size:\s*13px/s);
  assert.match(css, /font-weight:\s*700/);
});

test("unregistered task groups use a compact directory heading with secondary path", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function queueThreadSearch()"));
  assert.match(searchRenderer, /workspaceDirectoryName\(thread\.workspacePath\)/);
  assert.match(searchRenderer, /subtitle:\s*t\("threads\.unregisteredDirectoryDetail"/);
  assert.match(searchRenderer, /thread-group-subtitle/);
  assert.match(app, /"threads\.unregisteredDirectoryDetail":\s*"未登记目录 · \{path\}"/);
});

test("newly completed unread rows and collapsed groups are visually distinct", () => {
  const rowRenderer = app.slice(app.indexOf("function createThreadSearchRow("), app.indexOf("function queueThreadSearch()"));
  assert.match(rowRenderer, /const sidebarUnread = threadIsCodexSidebarUnread\(thread\)/);
  assert.match(rowRenderer, /threadTurnStateLabel\(thread\?\.turnState,\s*sidebarUnread\)/);
  assert.match(rowRenderer, /unread:\s*sidebarUnread/);
  assert.match(app, /unreadCompletedCount/);
  assert.match(app, /"threads\.state\.newlyCompleted":\s*"新完成"/);
  assert.match(app, /"threads\.unreadCompleted":\s*"新完成 \{count\}"/);
  assert.match(css, /\.thread-row\.is-unread\b/);
  assert.match(css, /\.thread-state\.is-newly-completed::before\b/);
});

test("unread terminal states use blue completion and red interruption dots", () => {
  const stateRenderer = app.slice(app.indexOf("function threadTurnStateLabel("), app.indexOf("function countUnreadTerminalStates("));
  assert.match(stateRenderer, /\["interrupted", "usage_limited"\]\.includes\(state\) && unread/);
  assert.match(stateRenderer, /key: "newly_interrupted"/);
  assert.match(stateRenderer, /state === "usage_limited"\s*\? "threads\.state\.usageLimited"\s*: "threads\.state\.interrupted"/);
  assert.match(css, /\.thread-state\.is-newly-completed::before\b/);
  assert.match(css, /\.thread-state\.is-newly-interrupted::before\b/);
  assert.match(css, /\.thread-state\.is-newly-completed::before[\s\S]*background:\s*#2878ff/s);
  assert.match(css, /\.thread-state\.is-newly-interrupted::before[\s\S]*background:\s*#d93025/s);
  assert.doesNotMatch(css, /\.thread-state\.is-interrupted::before/);
});

test("collapsed thread ancestors summarize unread completion and interruption separately", () => {
  const searchRenderer = app.slice(app.indexOf("function renderThreadSearchResults("), app.indexOf("function buildThreadHierarchy("));
  const grouping = app.slice(app.indexOf("function groupThreadSearchResults("), app.indexOf("function threadGroupIdentity("));
  const groupRenderer = app.slice(app.indexOf("function createThreadGroup("), app.indexOf("function renderThreadGroupBody("));
  const summaryHelpers = app.slice(app.indexOf("function countUnreadTerminalStates("), app.indexOf("function threadActivityEvidenceLabel("));

  assert.match(app, /"threads\.unreadInterrupted":\s*"新中断 \{count\}"/);
  assert.match(searchRenderer, /appendUnreadTerminalSummary\(heading,\s*pinnedUnreadStates\)/);
  assert.match(searchRenderer, /appendUnreadTerminalSummary\(metadata,\s*ordinaryUnreadStates/);
  assert.match(grouping, /unreadInterruptedCount:\s*0/);
  assert.match(grouping, /countUnreadTerminalStates\(thread\)/);
  assert.match(groupRenderer, /appendUnreadTerminalSummary\(metadata,\s*group/);
  assert.match(summaryHelpers, /const unread = threadIsCodexSidebarUnread\(thread\)/);
  assert.match(summaryHelpers, /completed:\s*unread && thread\?\.turnState === "completed" \? 1 : 0/);
  assert.match(summaryHelpers, /interrupted:\s*unread && \["interrupted", "usage_limited"\]\.includes\(thread\?\.turnState\) \? 1 : 0/);
  assert.doesNotMatch(summaryHelpers, /children\.reduce/);
  assert.match(summaryHelpers, /className = `thread-unread-summary is-\$\{state\}`/);
  assert.match(css, /\.thread-unread-summary\.is-completed::before[\s\S]*background:\s*#2878ff/s);
  assert.match(css, /\.thread-unread-summary\.is-interrupted::before[\s\S]*background:\s*#d93025/s);
});

test("Codex-hidden internal threads stay neutral and never bubble unread state", () => {
  const summaryHelpers = app.slice(app.indexOf("function threadIsCodexSidebarUnread("), app.indexOf("function threadActivityEvidenceLabel("));
  assert.match(summaryHelpers, /thread\?\.unread/);
  assert.match(summaryHelpers, /thread\?\.threadSource !== "subagent"/);
  assert.match(summaryHelpers, /!thread\?\.parentThreadId/);
  assert.match(summaryHelpers, /thread\?\.category !== "temporary_executor"/);
});

test("Threads activity refreshes cached presentation when Codex sidebar state changes", () => {
  const refresh = app.slice(app.indexOf("async function refreshThreadSidebarRevision()"), app.indexOf("function startThreadsActivityRefresh()"));
  assert.match(app, /let previousThreadSidebarStateRevision;/);
  assert.match(preload, /getCodexThreadSidebarStateRevision:\s*\(\)\s*=>\s*invoke\("threads:getSidebarRevision"\)/);
  assert.match(main, /"threads:getSidebarRevision":\s*\(\)\s*=>\s*accountService\.getCodexThreadSidebarStateRevision\(\)/);
  assert.match(app, /threadSidebarRevisionIntervalMs\s*=\s*5_000/);
  assert.match(app, /setInterval\(refreshThreadSidebarRevision, threadSidebarRevisionIntervalMs\)/);
  assert.match(refresh, /api\.getCodexThreadSidebarStateRevision\(\)/);
  assert.match(refresh, /previousThreadSidebarStateRevision !== nextThreadSidebarStateRevision/);
  assert.match(refresh, /queueThreadSearch\(\)/);
  assert.match(refresh, /currentView !== "threads"/);
  assert.match(accountService, /getCodexThreadSidebarStateRevision/);
});

test("an active task disappearing queues one persistent metadata refresh", () => {
  const refresh = app.slice(app.indexOf("async function refreshThreadsActivity()"), app.indexOf("function renderThreadsActivity()"));
  assert.match(refresh, /previousActiveThreadIds/);
  assert.match(refresh, /some\(\(id\) => !nextActiveThreadIds\.has\(id\)\)/);
  assert.match(refresh, /queueThreadSearch\(\)/);
});
