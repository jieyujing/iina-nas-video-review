<template>
  <div class="app-container" @focusin="handleReviewFocusIn" @focusout="handleReviewFocusOut">
    <!-- Header: + Button and Tabs -->
    <div class="header">
      <button class="add-btn" @click="showAddDialog = true">
        <span class="icon">+</span>
      </button>
      <button v-if="activeTab && !reviewMode && !directoryMode" class="review-switch" :disabled="reviewState.resumeAvailable || reviewPending" @click="startReview">Review</button>
      <button v-if="activeTab && !reviewMode" class="review-switch" @click="toggleDirectoryMode">{{ directoryMode ? "Video mode" : "Directory mode" }}</button>
      <button v-if="reviewMode" class="review-switch" :disabled="reviewState.deleteQueuePending>0" @click="exitReview">Folders</button>
      <button class="review-switch" @click="showDebugLog=!showDebugLog">{{ showDebugLog ? 'Back' : 'Logs' }}</button>
      <div class="tabs-wrapper" ref="tabsWrapper">
        <div
          v-for="(tab, index) in tabs"
          :key="tab.id"
          :class="['tab-item', { active: activeTabId === tab.id }]"
          @click="onTabClick(tab)"
          @dblclick.stop="onTabDoubleClick(tab)"
        >
          <span class="tab-name">{{ tab.name }}</span>
          <span class="close-btn" @click.stop="removeTab(index)" @dblclick.stop>×</span>
        </div>
      </div>
    </div>

    <!-- Content: File List -->
    <div class="content">
      <div v-if="!reviewMode && !showDebugLog && reviewState.resumeAvailable" class="resume-banner">
        <template v-if="reviewState.autoResumeSuspended && !showSavedReviewDetails">
          <strong>Review 已结束 · 进度已保存</strong>
          <div class="debug-actions">
            <button class="review-switch" :disabled="!canResumeSelected" @click="resumeReview">手动恢复 Review</button>
            <button class="review-switch" @click="showSavedReviewDetails=true">管理已保存的 Review</button>
          </div>
        </template>
        <template v-else>
        <strong>Saved Review available</strong>
        <p>{{ reviewState.resumeKept }} kept / {{ reviewState.resumeTotal }} videos.
          This restores only Review KEEP/queue progress. Open your video through
          IINA History to keep its native playback position and settings.
          {{ reviewState.resumeKind==='smb' ?
          'The original SMB share must be mounted. Resume verifies the saved source and media list automatically.' :
          'Resume verifies the saved original local test folder.' }}</p>
        <p>Saved folder: <strong>{{ resumeSourceLabel }}</strong></p>
        <p v-if="!canResumeSelected" class="resume-warning">
          The saved source path is unavailable. The existing checkpoint remains untouched.
        </p>
        <p v-if="reviewError" class="resume-warning">{{ reviewError }}</p>
        <div class="debug-actions">
          <button class="review-switch" :disabled="!canResumeSelected" @click="resumeReview">Resume Review Queue</button>
          <button class="review-switch" @click="discardReview">Discard checkpoint…</button>
        </div>
        <div v-if="discardConfirming" class="resume-warning">
          <p><strong>Discard saved Review progress?</strong> This permanently clears the saved KEEP decisions and queue cursor, but does not delete video files. You can then start a new Review.</p>
          <div class="debug-actions">
            <button class="review-switch" @click="cancelDiscardReview">Cancel</button>
            <button class="review-switch" @click="confirmDiscardReview">Confirm discard saved Review</button>
          </div>
        </div>
        </template>
      </div>
      <div v-if="showDebugLog" class="debug-panel">
        <h3>Debug Log</h3>
        <p>Local only · Last 200 events · No media paths or filenames</p>
        <div class="debug-actions">
          <button class="review-switch" @click="copyDebugLog">Copy logs</button>
          <button class="review-switch" @click="clearDebugLog">Clear logs</button>
          <span>{{ debugEntries.length }} events</span>
        </div>
        <p class="debug-status" v-if="debugCopyStatus">{{ debugCopyStatus }}</p>
        <textarea class="debug-output" readonly :value="formatDebugLog()" spellcheck="false"></textarea>
      </div>
      <div v-else-if="reviewMode" class="review-panel">
        <h3 class="review-heading">Review <span v-if="reviewState.nasReadOnly" class="review-source">SMB</span></h3>
        <div class="review-metrics" role="group" aria-label="Review statistics">
          <div class="review-metric">
            <strong>{{ reviewState.remainingCount ?? reviewState.entries.length }}</strong>
            <span>剩余</span>
          </div>
          <div class="review-metric">
            <strong>{{ reviewState.keptCount ?? reviewState.entries.filter(e => e.status === 'KEEP').length }}</strong>
            <span>KEEP</span>
          </div>
          <div class="review-metric">
            <strong>{{ reviewState.deletedCount ?? 0 }}</strong>
            <span>已删除</span>
          </div>
          <div v-if="reviewState.missingCount" class="review-metric">
            <strong>{{ reviewState.missingCount }}</strong>
            <span>缺失</span>
          </div>
        </div>
        <p class="review-error" v-if="reviewError">{{ reviewError }}</p>
        <div class="review-primary-actions">
          <button class="review-switch review-action-keep"
            :disabled="!reviewState.active || !reviewState.playbackMatched"
            @click="keepAndNext">Keep &amp; Next</button>
          <button class="review-switch review-action-delete"
            :disabled="!reviewState.active || !reviewState.deletePlaybackReady || !reviewState.deletionSupported || reviewState.deleteRecoveryPending || reviewState.deleteQueueBlocked"
            @click="requestDelete">Queue Delete (D)</button>
        </div>
        <label v-if="reviewState.nasReadOnly" class="review-scan-option review-compact-option">
          <input type="checkbox" :checked="reviewState.skipDeleteConfirmation===true"
            @change="setSkipDeleteConfirmation($event.target.checked)" />
          Skip delete confirmation · 直接永久删除
        </label>
        <div v-if="reviewState.nasReadOnly" class="delete-queue-status"
          :class="'queue-'+reviewState.deleteQueueStatus.toLowerCase()"
          role="status" aria-live="polite" aria-atomic="true">
          <div class="delete-queue-heading">
            <span class="delete-queue-dot" aria-hidden="true"></span>
            <strong v-if="reviewState.deleteQueueStatus==='COMPLETE'">删除队列已完成 · Delete queue complete</strong>
            <strong v-else-if="reviewState.deleteQueueStatus==='COMPLETE_WITH_WARNINGS'">队列已结束 · 存在异常</strong>
            <strong v-else-if="reviewState.deleteQueueStatus==='WORKING'">后台删除中</strong>
            <strong v-else-if="reviewState.deleteQueueStatus==='PAUSED'">删除队列已暂停</strong>
            <strong v-else-if="reviewState.deleteQueueStatus==='BLOCKED'">Deletion blocked · 需要核对</strong>
            <strong v-else>Delete queue idle · 队列空闲</strong>
          </div>
          <p v-if="reviewState.deleteQueueStatus==='COMPLETE'">
            Safe to close IINA · 本轮 {{ reviewState.deleteQueueDeleted }} 个已删除
          </p>
          <p v-else-if="reviewState.deleteQueueStatus==='COMPLETE_WITH_WARNINGS'">
            可关闭 IINA · {{ reviewState.deleteQueueFailed }} 失败 ·
            {{ reviewState.deleteQueueReconciled }} 已核对
          </p>
          <p v-else-if="reviewState.deleteQueueStatus==='WORKING'">
            {{ reviewState.deleteQueueRunning }} 执行中 · {{ reviewState.deleteQueueWaiting }} 等待 · 请保持 IINA 开启
          </p>
          <p v-else-if="reviewState.deleteQueueStatus==='PAUSED'">
            {{ reviewState.deleteQueuePaused }} 个任务待恢复 · 不会自动续删
          </p>
          <p v-else-if="reviewState.deleteQueueStatus==='BLOCKED'">
            {{ reviewState.deleteQueueUnknown }} UNKNOWN · {{ reviewState.deleteQueuePaused }} 暂停 · 请人工核对
          </p>
          <p v-else>暂无后台删除任务</p>
        </div>
        <p v-if="reviewNotice && (!reviewState.playbackMatched || reviewState.phase==='COMPLETE')"
          class="review-context-notice">{{ reviewNotice }}</p>
        <p v-if="reviewState.deleteQueueNotice" class="review-error">{{ reviewState.deleteQueueNotice }}</p>
        <button v-if="reviewState.deleteQueuePaused && !reviewState.deleteQueueBlocked" class="review-switch" @click="resumePausedDeletes">Review &amp; resume {{ reviewState.deleteQueuePaused }} unissued deletion(s)…</button>
        <button v-if="reviewState.deleteQueuePaused || reviewState.deleteQueueWaiting" class="review-switch" @click="cancelUnissuedAndExit">取消未执行的删除任务并退出 Review…</button>
        <p v-if="reviewState.deleteRecoveryPending" class="review-error">
          UNKNOWN：请先在 Finder 核对原文件；不会自动重删。
        </p>
        <button v-if="reviewState.active && reviewState.nasReadOnly && reviewState.deleteRecoveryPending"
          class="review-switch" @click="acknowledgeUnknownDelete">
          Reconcile queued UNKNOWN…
        </button>
        <button v-if="reviewState.active || reviewState.phase==='COMPLETE'" class="review-switch"
          :disabled="reviewState.deleteInFlight || reviewState.deleteQueueRunning>0 || reviewState.deleteQueueWaiting>0"
          @click="endAndExitReview">结束并退出 Review…</button>

        <p v-if="reviewState.active && reviewState.playbackLoadFailed" class="review-error">视频加载未成功：当前条目仍为待处理，K/D 已暂停。可以尝试重新打开，或跳至下一条待处理视频。</p>
        <button v-if="reviewState.active && reviewState.playbackLoadFailed" class="review-switch" @click="skipFailedReviewVideo">跳过此加载失败项并播放下一条（不标记 KEEP）</button>
        <button v-if="reviewState.active && reviewState.playbackCanAttach" class="review-switch" @click="attachPlayingReviewVideo">将当前已加载视频设为 Review 待处理项（不标记 KEEP）</button>
        <button v-if="reviewState.active && reviewState.playbackMatched===false" class="review-switch" @click="reopenReviewVideo">Reopen current Review item</button>
        <div class="review-list-toolbar">
          <div class="review-list-meta">
            <strong>视频列表</strong>
            <span>{{ reviewState.recursive ? '含子目录' : '当前目录' }} ·
              {{ reviewState.totalCount ? reviewState.windowStart + 1 : 0 }}–{{ reviewState.windowStart + reviewState.entries.length }} / {{ reviewState.totalCount }}</span>
          </div>
          <button class="review-switch review-tool-button"
            :disabled="!reviewState.active || !reviewState.playbackMatched"
            @click="openThumbnails">Timeline</button>
        </div>
        <p v-if="reviewWindowError" class="review-error">{{ reviewWindowError }}</p>
        <ul class="review-files" ref="reviewList" aria-label="Review videos"
          tabindex="0" @scroll.passive="handleReviewListScroll"
          @wheel.passive="markReviewManualBrowse"
          @touchmove.passive="markReviewManualBrowse"
          @pointerdown.passive="markReviewManualBrowse"
          @keydown="markReviewKeyboardBrowse">
          <li v-for="(item,i) in reviewState.entries" :key="item.name"
            :data-review-position="item.position ?? i"
            :aria-current="(item.position ?? i)===reviewState.playingPosition?'true':null"
            :class="{ current:(item.position ?? i)===reviewState.cursor, playing:(item.position ?? i)===reviewState.playingPosition }">
            <button class="review-item-play" :disabled="(!reviewState.active && !(reviewState.phase==='COMPLETE' && item.status==='KEEP')) || reviewState.playbackStatus==='awaiting_file_loaded' || ['DELETED','MISSING','QUEUED','RUNNING','PAUSED','UNKNOWN'].includes(item.status)"
              :aria-label="'Play '+item.name" @click="playReviewItem(item,i)">
              <span class="review-entry-name">{{ item.name }}</span>              <span class="review-entry-status">
                <strong v-if="(item.position ?? i)===reviewState.playingPosition" class="review-playing-label">▶ PLAYING</strong>
                <small>{{ item.status }}</small>
              </span>
            </button>
          </li>
        </ul>
        <details class="review-more">
          <summary>高级设置与帮助</summary>
          <div class="review-more-content">
            <div v-if="reviewState.nasReadOnly" class="review-more-section">
              <strong>NAS 备份</strong>
              <div class="review-more-controls">
                <button class="review-switch"
                  @click="setNASBackup(!reviewState.nasBackupEnabled)">
                  {{ reviewState.nasBackupEnabled ? 'Pause NAS backup' : 'Enable NAS folder backup' }}
                </button>
                <span>NAS snapshot: {{ reviewState.nasBackupStatus || 'disabled' }}</span>
              </div>
              <p>Automatic for verified SMB Review folders. Writes only
                .iina-nas-review metadata here; Pause is remembered per folder.
                Local KEEP remains primary; conflicting NAS data is never overwritten.</p>
            </div>
            <div class="review-more-section">
              <strong>播放与快捷键</strong>
              <p>Click a video to play it. Natural completion or dragging to the final seconds marks it KEEP and advances; skipped videos stay pending.</p>
              <p>{{ reviewState.kShortcutEnabled ? 'K = Keep & Next (player or sidebar, while reviewing)' : 'K shortcut unavailable in player; use the button or sidebar shortcut' }}</p>
              <p>K listener: {{ reviewState.kRegistration || 'Unknown' }} · Player K events: {{ reviewState.kInputEvents || 0 }}</p>
              <p>Last K: {{ reviewState.lastKResult || 'None' }}</p>
              <p v-if="reviewState.playbackMatched">{{ reviewNotice }}</p>
            </div>
            <div class="review-more-section">
              <strong>删除说明</strong>
              <p v-if="reviewState.deletionSupported">
                D permanently deletes only the current Review video{{ reviewState.skipDeleteConfirmation ? " without confirmation" : " after native confirmation" }}. SMB pathname deletion is not atomic and cannot be undone.
              </p>
              <p v-else>D applies only to the current playing Review video on a verified SMB share.</p>
              <p v-if="!reviewState.nasReadOnly">Development local fixture · No permanent delete</p>
            </div>
          </div>
        </details>
      </div>
      <div v-else-if="activeTab" class="file-list">
        <button v-if="activeTab.currentPath?.startsWith('/Volumes/') &&
          !reviewState.resumeAvailable && !reviewState.active"
          class="review-switch" @click="importNASReview">
          Restore Review from NAS backup…
        </button>
        <div v-if="directoryMode" class="review-panel">
          <h3>Directory mode · SMB</h3>
          <p class="review-shortcut">Click a folder to select; double-click to enter. Press D or use Delete selected folder. Each folder deletion needs two confirmations.</p>
          <p class="review-error">Deleting a directory removes ALL nested videos, subtitles and files. No Trash or undo. This is non-atomic pathname deletion.</p>
          <p v-if="directorySelected">Selected: <strong>{{ directorySelected.name }}</strong></p>
          <button class="review-switch" :disabled="!directorySelected || directoryDeleting" @click="requestDirectoryDelete">Permanently delete selected folder…</button>
          <button v-if="directoryDeleteUnknown" class="review-switch" :disabled="directoryDeleting" @click="reconcileDirectoryDelete">Acknowledge missing folder (UNKNOWN)…</button>
          <p v-if="directoryNotice" class="review-shortcut">{{ directoryNotice }}</p>
        </div>
        <p v-if="reviewError" class="review-error">{{ reviewError }}</p>
        <label v-if="!directoryMode" class="review-scan-option">
          <input type="checkbox" v-model="reviewRecursive" />
          Include videos in subfolders (recursive scan)
        </label>
        <div
          v-for="item in (directoryMode ? activeTab.files.filter(entry=>entry.isDir===true) : activeTab.files)"
          :key="item.path"
          class="file-item"
          :class="{'active': item.path === activePlayFilePath || (directoryMode && directorySelected?.path === item.path)}"
          @click="handleItemClick(item)"
          @dblclick.stop="enterDirectoryItem(item)"
        >
          <span class="file-icon">{{ item.isDir ? '🗂️' : '📹' }}</span>
          <span class="file-name">{{ item.filename }}</span>
        </div>
      </div>
      <div v-else class="empty-state">
        <p>Click + to add a folder</p>
      </div>
    </div>

    <!-- Add Folder Dialog -->
    <div v-if="showAddDialog" class="modal-overlay">
      <div class="modal-content">
        <h3>Add Folder</h3>
        <div class="form-group">
          <label>Path</label>
          <div class="path-select-group">
            <input v-model="newFolderPath" placeholder="Select or paste a local folder path" spellcheck="false" />
            <button @click="chooseFolder">Select</button>
          </div>
        </div>
        <div class="form-group">
          <label>Name</label>
          <input v-model="newFolderName" placeholder="Enter folder alias" />
          <span v-if="isDuplicateName" class="error-msg">Name already exists</span>
        </div>
        <div class="modal-actions">
          <button @click="showAddDialog = false">Cancel</button>
          <button class="primary" @click="addTab" :disabled="!newFolderName || !newFolderPath || isDuplicateName">
            Confirm
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>

export default {
  data() {
    return {
      showAddDialog: false,
      newFolderName: "",
      newFolderPath: "",
      activeTabId: null,
      activePlayFilePath: null,
      tabs: [],
      tabClickTimerId: null,
      reviewMode: false,
      directoryMode: false,
      directorySelected: null,
      directoryDeleting: false,
      directoryDeleteUnknown: false,
      directoryNotice: "",
      reviewRecursive: false,
      discardConfirming: false,
      showSavedReviewDetails: false,
      reviewError: "",
      reviewNotice: "",
      showDebugLog: false,
      debugEntries: [],
      debugSequence: 0,
      debugCopyStatus: "",
      reviewPending: false,
      reviewTimerId: null,
      reviewCenteredKey: "",
      reviewManualBrowsing: false,
      reviewWindowPending: null,
      reviewWindowRequestId: 0,
      reviewWindowTimerId: null,
      reviewWindowError: "",
      reviewState: {entries:[],cursor:-1,playingPosition:-1,active:false,phase:"IDLE",nasReadOnly:false,recursive:false,deletionSupported:false,deletePlaybackReady:false,deleteRecoveryPending:false,deleteInFlight:false,deleteQueuePending:0,deleteQueuePaused:0,deleteQueueBlocked:false,deleteQueueStatus:"IDLE",deleteQueueCanClose:false,deleteQueueRunning:0,deleteQueueWaiting:0,deleteQueueUnknown:0,deleteQueueDeleted:0,deleteQueueFailed:0,deleteQueueReconciled:0,deleteQueueCancelled:0,deleteQueueNotice:"",skipDeleteConfirmation:false,totalCount:0,remainingCount:0,keptCount:0,deletedCount:0,missingCount:0,windowStart:0,playbackMatched:false,playbackStatus:"session_inactive",kShortcutEnabled:false,kRegistration:"Unknown",kInputEvents:0,lastKResult:"None",resumeAvailable:false,resumeTotal:0,resumeKept:0,resumeSource:"",nasBackupEnabled:false,nasBackupStatus:"disabled"},
    };
  },
  computed: {
    activeTab() {
      return this.tabs.find((t) => t.id === this.activeTabId);
    },
    isDuplicateName() {
      return this.tabs.some((t) => t.name === this.newFolderName.trim());
    },
    resumeSourceLabel(){
      const source=this.reviewState.resumeSource;
      return typeof source==="string" &&
        (source.startsWith("/private/tmp/iina-nas-review-fixture-") ||
         source.startsWith("/Volumes/")) ?
        (source.startsWith("/Volumes/")?"SMB · ":"")+source.split("/").pop():
        "Unknown source";
    },
    savedSourceTab(){
      const source=this.reviewState.resumeSource;
      if(typeof source!=="string" ||
         !(source.startsWith("/private/tmp/iina-nas-review-fixture-")||
           source.startsWith("/Volumes/")))return undefined;
      return this.tabs.find(tab=>tab.currentPath===source);
    },
    canResumeSelected(){
      const source=this.reviewState.resumeSource;
      return this.reviewState.resumeAvailable===true &&
        typeof source==="string" &&
        (source.startsWith("/private/tmp/iina-nas-review-fixture-")||
         source.startsWith("/Volumes/"));
    },
  },
  watch: {
    showDebugLog(isOpen){
      if(!isOpen&&this.reviewMode&&!this.reviewManualBrowsing)
        this.centerReviewAfterRender();
    }
  },
  methods: {
    centerReviewList(){
      if(!this.reviewMode || this.showDebugLog)return;
      const list=this.$refs?.reviewList;
      if(!list?.children)return;
      const index=this.reviewState.playingPosition>=0?
        this.reviewState.playingPosition:this.reviewState.cursor;
      if(!Number.isInteger(index)||index<0)return;
      const target=Array.from(list.children).find(node=>
        Number(node.dataset?.reviewPosition)===index);
      if(!target)return;
      try{
        target.scrollIntoView({block:"center",inline:"nearest",behavior:"auto"});
      }catch(_){
        // Older IINA WebKit: keep a safe local-scroll fallback.
        if(Number.isFinite(target.offsetTop)&&Number.isFinite(list.clientHeight))
          list.scrollTop=Math.max(0,target.offsetTop-
            (list.clientHeight-target.offsetHeight)/2);
      }
    },
    centerReviewAfterRender(){
      if(typeof this.$nextTick==="function")
        this.$nextTick(()=>this.centerReviewList());
      else this.centerReviewList();
    },
    markReviewManualBrowse(){
      if(this.reviewMode&&!this.showDebugLog&&
         (this.reviewState.active||this.reviewState.phase==="COMPLETE"))
        this.reviewManualBrowsing=true;
    },
    markReviewKeyboardBrowse(event){
      if(["ArrowDown","ArrowUp","PageDown","PageUp","Home","End"," "]
        .includes(event?.key))this.markReviewManualBrowse();
    },
    clearReviewWindowTimer(){
      if(this.reviewWindowTimerId!==null){
        clearTimeout(this.reviewWindowTimerId);
        this.reviewWindowTimerId=null;
      }
    },
    resetReviewBrowsing(){
      this.clearReviewWindowTimer();
      this.reviewWindowPending=null;
      this.reviewManualBrowsing=false;
      this.reviewWindowError="";
      this.reviewCenteredKey="";
    },
    requestReviewWindow(start){
      if(!this.reviewMode||
         !(this.reviewState.active||this.reviewState.phase==="COMPLETE")||
         this.reviewWindowPending||!window.iina?.postMessage ||
         !Number.isSafeInteger(start)||start<0)return false;
      const total=this.reviewState.totalCount;
      if(!Number.isSafeInteger(total)||total<=this.reviewState.entries.length)
        return false;
      const size=120;
      const bounded=Math.max(0,Math.min(start,Math.max(0,total-size)));
      const id=++this.reviewWindowRequestId;
      const epoch=this.reviewState.sessionEpoch;
      if(!Number.isSafeInteger(epoch))return false;
      this.reviewWindowPending={requestId:id,sessionEpoch:epoch,start:bounded};
      this.reviewWindowError="";
      // Install the timeout before dispatch: a synchronous mock/bridge reply
      // must be able to clear it, not leave an orphaned timeout behind.
      this.clearReviewWindowTimer();
      this.reviewWindowTimerId=setTimeout(()=>{
        if(this.reviewWindowPending?.requestId===id){
          this.reviewWindowPending=null;
          this.reviewWindowError="Review list request timed out. Scroll again to retry.";
        }
        this.reviewWindowTimerId=null;
      },4000);
      try{
        window.iina.postMessage("review-window",{
          sessionEpoch:epoch,requestId:id,start:bounded
        });
      }catch(_){
        this.reviewWindowPending=null;
        this.clearReviewWindowTimer();
        this.reviewWindowError="Unable to load this part of Review. Scroll again to retry.";
        return false;
      }
      return true;
    },
    handleReviewListScroll(event){
      if(!this.reviewManualBrowsing||this.reviewWindowPending ||
         this.showDebugLog||
         !(this.reviewState.active||this.reviewState.phase==="COMPLETE"))return;
      const list=event?.target;
      if(!list||!Number.isFinite(list.scrollTop)||
         !Number.isFinite(list.scrollHeight)||
         !Number.isFinite(list.clientHeight))return;
      const start=this.reviewState.windowStart||0;
      const maxStart=Math.max(0,this.reviewState.totalCount-120);
      if(list.scrollTop<=72 && start>0)
        this.requestReviewWindow(Math.max(0,start-60));
      else if(list.scrollHeight-list.scrollTop-list.clientHeight<=72 &&
        start<maxStart)
        this.requestReviewWindow(Math.min(maxStart,start+60));
    },
    reviewVisibleAnchor(list){
      if(!list?.children)return null;
      const listRect=typeof list.getBoundingClientRect==="function"?
        list.getBoundingClientRect():null;
      for(const node of Array.from(list.children)){
        const index=Number(node.dataset?.reviewPosition);
        if(!Number.isSafeInteger(index)||index<0)continue;
        const rect=listRect&&typeof node.getBoundingClientRect==="function"?
          node.getBoundingClientRect():null;
        if(rect && rect.bottom>listRect.top+2)
          return {position:index,top:rect.top-listRect.top,rect:true};
        if(!rect && Number.isFinite(node.offsetTop) &&
           node.offsetTop+(node.offsetHeight||0)>list.scrollTop)
          return {position:index,top:node.offsetTop,rect:false};
      }
      return null;
    },
    applyReviewWindow(data){
      const pending=this.reviewWindowPending;
      if(!pending||pending.requestId!==data?.requestId||
         pending.sessionEpoch!==data?.sessionEpoch||
         data.sessionEpoch!==this.reviewState.sessionEpoch ||
         !Array.isArray(data.entries)||data.entries.length>120 ||
         data.totalCount!==this.reviewState.totalCount ||
         !Number.isSafeInteger(data.windowStart)||data.windowStart<0 ||
         data.windowStart+data.entries.length>data.totalCount ||
         data.entries.some((entry,i)=>
           entry?.position!==data.windowStart+i ||
           typeof entry.name!=="string"||
           !["PENDING","KEEP","DELETED","MISSING"].includes(entry.status))
      )return;
      if(Number.isSafeInteger(data.viewRevision) &&
         data.viewRevision<this.reviewState.viewRevision){
        // An older page may arrive after KEEP or D persisted newer statuses.
        this.reviewWindowPending=null;
        this.clearReviewWindowTimer();
        this.requestReviewWindow(pending.start);
        return;
      }
      const list=this.$refs?.reviewList;
      const anchor=this.reviewManualBrowsing?this.reviewVisibleAnchor(list):null;
      this.reviewWindowPending=null;
      this.clearReviewWindowTimer();
      this.reviewWindowError="";
      this.reviewState={...this.reviewState,windowStart:data.windowStart,
        viewRevision:Number.isSafeInteger(data.viewRevision)?
          data.viewRevision:this.reviewState.viewRevision,
        entries:data.entries};
      if(anchor && typeof this.$nextTick==="function"){
        this.$nextTick(()=>{
          const active=this.$refs?.reviewList;
          const node=Array.from(active?.children||[]).find(child=>
            Number(child.dataset?.reviewPosition)===anchor.position);
          if(!node||!active)return;
          const rect=anchor.rect&&typeof node.getBoundingClientRect==="function"&&
            typeof active.getBoundingClientRect==="function"?
            node.getBoundingClientRect():null;
          const top=rect?rect.top-active.getBoundingClientRect().top:
            node.offsetTop;
          if(Number.isFinite(top)&&Number.isFinite(active.scrollTop))
            active.scrollTop=Math.max(0,active.scrollTop+top-anchor.top);
        });
      }
    },
    safeDebugData(data){
      // Mirrors viewer-fork/src/debug-log.cjs ALLOWED_KEYS. Both lists must be
      // updated together or new diagnostic fields are silently dropped here
      // (progressClass/sequence lost their first real capture for this reason).
      const allowed=new Set(["count","total","cursor","kept","active","allowed","enabled",
        "accepted","matched","focused","repeat","next","source","reason","stage",
        "status","outcome","errorName","hasBinding","success",
        "targetSeconds","actualSeconds","paused","attempt","nearEnd",
        "progressClass","sequence","loadedIndex","loadedStatus","awaitingLoad","canAttach"]);      const clean={};
      if(!data||typeof data!=="object"||Array.isArray(data))return clean;
      for(const key of Object.keys(data).slice(0,24)){
        if(!allowed.has(key))continue;
        const value=data[key];
        if(typeof value==="boolean")clean[key]=value;
        else if(typeof value==="number"&&Number.isFinite(value))clean[key]=value;
        else if(typeof value==="string"&&/^[a-zA-Z0-9_. -]{1,64}$/.test(value)&&
          !value.includes("..")&&!value.includes("  "))clean[key]=value;
      }
      return clean;
    },
    appendDebugEvent(raw){
      if(!raw||typeof raw!=="object"||typeof raw.id!=="string"||
        !/^[a-zA-Z0-9_-]{1,90}$/.test(raw.id))return;
      if(this.debugEntries.some(entry=>entry.id===raw.id))return;
      const entry={
        id:raw.id,
        at:typeof raw.at==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(raw.at)?
          raw.at.slice(0,24):new Date().toISOString(),
        source:raw.source==="backend"?"backend":"ui",
        level:["info","warn","error"].includes(raw.level)?raw.level:"info",
        event:typeof raw.event==="string"&&/^[a-z][a-z0-9_.-]{0,63}$/.test(raw.event)?
          raw.event:"unknown.event",
        data:this.safeDebugData(raw.data)
      };
      this.debugEntries.push(entry);
      this.debugEntries.sort((a,b)=>a.at.localeCompare(b.at));
      if(this.debugEntries.length>200)this.debugEntries.splice(0,this.debugEntries.length-200);
      try{localStorage.setItem("nas-review-debug-v1",JSON.stringify(this.debugEntries));}catch(_){}
    },
    logDebug(event,data={},level="info"){
      this.appendDebugEvent({
        id:"ui-"+Date.now()+"-"+(++this.debugSequence),
        at:new Date().toISOString(),source:"ui",level,event,data
      });
    },
    loadDebugLog(){
      try{
        const entries=JSON.parse(localStorage.getItem("nas-review-debug-v1")||"[]");
        if(Array.isArray(entries))for(const entry of entries.slice(-200))this.appendDebugEvent(entry);
      }catch(_){this.debugEntries=[];}
    },
    formatDebugLog(){
      const heading="NAS Review Debug Log — local diagnostic export\n";
      return heading+this.debugEntries.map(entry=>
        "["+entry.at+"] ["+entry.source+"] ["+entry.level+"] "+
        entry.event+" "+JSON.stringify(entry.data)
      ).join("\n");
    },
    async copyDebugLog(){
      try{
        if(typeof window.navigator?.clipboard?.writeText!=="function")throw new Error("clipboard unavailable");
        await window.navigator.clipboard.writeText(this.formatDebugLog());
        this.debugCopyStatus="Copied. Paste into your bug report.";
      }catch(_){
        this.debugCopyStatus="Copy unavailable: select the log text and copy manually.";
      }
    },
    clearDebugLog(){
      this.debugEntries=[];
      this.debugCopyStatus="";
      try{localStorage.setItem("nas-review-debug-v1","[]");}catch(_){}
      try{window.iina?.postMessage("debug-clear",{});}catch(_){}
    },
    handleSidebarKeydown(event){
      if(this.showDebugLog || !window.iina ||
         typeof window.iina.postMessage!=="function")return;
      const pressed=String(event?.key||"").toLowerCase();
      if(this.directoryMode && !this.reviewMode){
        if(pressed==="d" && this.directorySelected && !this.directoryDeleting &&
          !event?.repeat && !event?.metaKey && !event?.altKey &&
          !event?.ctrlKey && !event?.shiftKey &&
          !this.isTextEditingElement(event?.target)){
          event.preventDefault?.();
          event.stopPropagation?.();
          this.requestDirectoryDelete();
        }
        return;
      }
      if(!this.reviewMode || !this.reviewState.active)return;
      if(!["k","d"].includes(pressed) || event?.repeat ||
         event?.metaKey || event?.altKey || event?.ctrlKey || event?.shiftKey ||
         this.isTextEditingElement(event?.target))return;
      if(pressed==="k"&&!this.reviewState.playbackMatched)return;
      if(pressed==="d"&&!this.reviewState.deletePlaybackReady)return;
      event.preventDefault?.();
      event.stopPropagation?.();
      if(pressed==="k"){
        this.logDebug("ui.k.received",{source:"sidebar"});
        window.iina.postMessage("review-keep",{source:"sidebar-key"});
      }else{
        this.requestDelete();
      }
    },
    isTextEditingElement(element){
      const tag=String(element?.tagName||"").toUpperCase();
      return ["INPUT","TEXTAREA","SELECT"].includes(tag) || element?.isContentEditable===true;
    },
    handleReviewFocusIn(event){
      if(this.isTextEditingElement(event?.target)){
        window.iina?.postMessage("review-input-focus",{focused:true});
      }
    },
    handleReviewFocusOut(event){
      if(this.isTextEditingElement(event?.target) && !this.isTextEditingElement(event?.relatedTarget)){
        window.iina?.postMessage("review-input-focus",{focused:false});
      }
    },
    startReview(){
      if(!this.activeTab)return;
      if(this.reviewState.resumeAvailable){
        this.reviewError="An unfinished Review exists. Resume it, or explicitly discard its saved progress before starting over.";
        this.logDebug("ui.review.start_blocked",{reason:"unfinished_checkpoint"},"warn");
        return;
      }
      this.logDebug("ui.review.request");
      this.resetReviewBrowsing();
      this.reviewMode=true;
      this.reviewError="Checking selected folder and mounted source…";
      this.clearReviewTimer();
      if(!window.iina || typeof window.iina.postMessage!=="function"){
        this.logDebug("ui.review.bridge_unavailable",{},"warn");
        this.reviewError="IINA plugin message bridge unavailable. Try reopening the player window.";
        this.reviewPending=false;
        return;
      }
      this.reviewPending=true;
      try {
        window.iina.postMessage("review-start",{
          path:this.activeTab.currentPath,recursive:this.reviewRecursive===true
        });
      }catch(error){
        this.logDebug("ui.review.send_failed",{},"error");
        this.reviewPending=false;
        this.reviewError="Unable to send review request: "+String(error);
        return;
      }
      this.reviewTimerId=setTimeout(()=>{
        if(this.reviewPending){
          this.logDebug("ui.review.timeout",{},"warn");
          this.reviewPending=false;
          this.reviewError="No response from IINA plugin. The Review message handler may not be running.";
        }
      },this.reviewRecursive?120000:5000);
    },
    resumeReview(){
      if(!this.canResumeSelected){
        this.reviewError="Saved Review source is unavailable.";
        this.logDebug("ui.review.resume_wrong_source",{},"warn");
        return;
      }
      if(!window.iina || typeof window.iina.postMessage!=="function")return;
      this.logDebug("ui.review.resume_request");
      this.reviewError="Verifying saved Review against the original source…";
      this.reviewPending=true;
      try{
        window.iina.postMessage("review-resume",{path:this.reviewState.resumeSource});
      }catch(_){
        this.reviewPending=false;
        this.reviewError="Could not send Resume request.";
      }
    },
    discardReview(){
      if(this.reviewMode || this.reviewState.active || !this.reviewState.resumeAvailable)return;
      this.discardConfirming=true;
    },
    cancelDiscardReview(){
      this.discardConfirming=false;
    },
    confirmDiscardReview(){
      if(!this.discardConfirming || this.reviewMode || this.reviewState.active ||
         !this.reviewState.resumeAvailable)return;
      if(!window.iina || typeof window.iina.postMessage!=="function"){
        this.reviewError="IINA message bridge unavailable. Saved progress was not discarded.";
        return;
      }
      try{
        window.iina.postMessage("review-discard",{});
        this.logDebug("ui.review.discard_request",{source:"confirmed"});
        this.discardConfirming=false;
      }catch(_){
        this.reviewError="Failed to request discard. Saved progress was not discarded.";
      }
    },
    selectSavedSource(){
      const tab=this.savedSourceTab;
      if(!tab)return;
      this.reviewError="";
      this.logDebug("ui.review.saved_source_selected");
      this.tabClick(tab);
    },
    openThumbnails(){
      if(!this.reviewMode || !this.reviewState.active || !this.reviewState.playbackMatched || !window.iina ||
         typeof window.iina.postMessage!=="function")return;
      this.logDebug("ui.thumbnail.request");
      window.iina.postMessage("review-thumbnails-toggle",{});
    },
    reopenReviewVideo(){
      if(!this.reviewMode || !this.reviewState.active ||
         this.reviewState.playbackMatched!==false ||
         !window.iina || typeof window.iina.postMessage!=="function")return;
      this.logDebug("ui.review.reopen_request");
      window.iina.postMessage("review-reopen",{});
    },
    setNASBackup(enabled){
      if(!this.reviewMode || !this.reviewState.nasReadOnly)return;
      window.iina?.postMessage("review-nas-backup-enable",{enabled:enabled===true});
    },
    importNASReview(){
      if(!this.activeTab || this.reviewState.resumeAvailable ||
         this.reviewState.active || !this.activeTab.currentPath?.startsWith("/Volumes/"))
        return;
      this.reviewError="Validating NAS directory backup…";
      window.iina?.postMessage("review-nas-backup-import",{
        path:this.activeTab.currentPath
      });
    },
    clearReviewTimer(){
      if(this.reviewTimerId!==null){
        clearTimeout(this.reviewTimerId);
        this.reviewTimerId=null;
      }
    },
    keepAndNext(){
      if(!this.reviewMode || !this.reviewState.active || !this.reviewState.playbackMatched)return;
      this.logDebug("ui.keep.request",{source:"button"});
      window.iina?.postMessage("review-keep",{});
    },
    attachPlayingReviewVideo(){
      if(!this.reviewMode || !this.reviewState.active || !this.reviewState.playbackCanAttach)return;
      window.iina?.postMessage("review-attach-playing",{});
    },
    skipFailedReviewVideo(){
      if(!this.reviewMode || !this.reviewState.active || !this.reviewState.playbackLoadFailed)return;
      window.iina?.postMessage("review-skip-failed",{});
    },
    playReviewItem(item,index){
      if(!this.reviewMode ||
         (!this.reviewState.active && !(this.reviewState.phase==="COMPLETE" && item?.status==="KEEP")) ||
         this.reviewState.playbackStatus==="awaiting_file_loaded" ||
         !window.iina || typeof window.iina.postMessage!=="function")return;
      const position=Number.isInteger(item?.position)?item.position:index;
      if(!Number.isInteger(position)||position<0||
         position>=this.reviewState.totalCount)return;
      this.logDebug("ui.review.play_selected",{position});
      // Selecting a visible row is deliberate navigation; follow that
      // video again rather than retaining the previous manual scroll window.
      this.resetReviewBrowsing();
      window.iina.postMessage("review-play",{position});
    },
    setSkipDeleteConfirmation(enabled){
      if(!window.iina?.postMessage)return;
      window.iina.postMessage("review-delete-confirmation-setting",enabled===true);
    },
    requestDelete(){
      if(!this.reviewMode || !this.reviewState.active || !this.reviewState.deletePlaybackReady ||
         !this.reviewState.deletionSupported ||
         this.reviewState.deleteRecoveryPending ||
         !window.iina || typeof window.iina.postMessage!=="function")return;
      this.logDebug("ui.delete.request",{source:"review"});
      window.iina.postMessage("review-delete",{});
    },
    resumePausedDeletes(){
      window.iina?.postMessage("review-resume-paused-deletes",{});
    },
    acknowledgeUnknownDelete(){
      if(!this.reviewMode || !this.reviewState.active ||
         !this.reviewState.nasReadOnly || !window.iina?.postMessage)return;
      this.logDebug("ui.delete.unknown_reconcile_requested");
      window.iina.postMessage("review-delete-test-acknowledge-unknown",{});
    },
    cancelUnissuedAndExit(){
      window.iina?.postMessage("review-cancel-unissued-and-exit",{});
    },
    endAndExitReview(){
      if(!this.reviewMode ||
         (!this.reviewState.active && this.reviewState.phase!=="COMPLETE") ||
         this.reviewState.deleteInFlight || this.reviewState.deleteQueueRunning>0 ||
         this.reviewState.deleteQueueWaiting>0 || !window.iina?.postMessage)return;
      this.logDebug("ui.review.end_exit_requested");
      window.iina.postMessage("review-end-and-exit",{});
    },
    exitReview(alreadyExited=false){
      if(alreadyExited!==true && this.reviewState.deleteQueuePending>0)return false;
      this.logDebug("ui.review.exit");
      this.clearReviewTimer();
      this.resetReviewBrowsing();
      this.reviewPending=false;
      this.reviewMode=false;
      this.showSavedReviewDetails=false;
      this.reviewCenteredKey="";
      this.reviewError="";
      this.reviewNotice="";
      if(alreadyExited!==true)this.reviewState={entries:[],cursor:-1,playingPosition:-1,active:false,phase:"IDLE",nasReadOnly:false,recursive:false,deletionSupported:false,deletePlaybackReady:false,totalCount:0,remainingCount:0,keptCount:0,deletedCount:0,missingCount:0,windowStart:0,playbackMatched:false,playbackStatus:"session_inactive",kShortcutEnabled:false,kRegistration:"Unknown",kInputEvents:0,lastKResult:"None",resumeAvailable:false,resumeTotal:0,resumeKept:0,resumeSource:""};
      if(alreadyExited!==true)window.iina?.postMessage("review-exit",{});
    },
    addTab() {
      if(this.reviewState.deleteQueuePending>0)return;
      const name = this.newFolderName.trim();
      if (!name || this.tabs.some(t => t.name === name)) return;
      // Adding a bookmark changes the selected source; the previous source's
      // review is not transferable to the new folder.
      if(this.reviewMode){
        this.exitReview();
      }

      const newTab = {
        id: Date.now(),
        name: name,
        path: this.newFolderPath,
        currentPath: this.newFolderPath,
        files: [], // Will be populated by plugin
      };
      this.tabs.push(newTab);
      this.activeTabId = newTab.id;
      if(this.directoryMode)window.iina?.postMessage("directory-mode",{enabled:true,root:newTab.path});
      this.showAddDialog = false;
      this.newFolderName = "";
      this.newFolderPath = "";

      // Request file list for this new tab
      window.iina?.postMessage("get-files", { path: newTab.path, currentPath: newTab.currentPath, tabId: newTab.id });
      this.persistTabData();
    },
    clearPendingTabClick(){
      if(this.tabClickTimerId!==null){
        clearTimeout(this.tabClickTimerId);
        this.tabClickTimerId=null;
      }
    },
    onTabClick(tab){
      // dblclick emits two click events before dblclick. Deferring tab
      // selection prevents a double click on another folder from exiting
      // the active Review before that tab is closed.
      this.clearPendingTabClick();
      const id=tab?.id;
      this.tabClickTimerId=setTimeout(()=>{
        this.tabClickTimerId=null;
        const live=this.tabs.find(candidate=>candidate.id===id);
        if(live)this.tabClick(live);
      },270);
    },
    onTabDoubleClick(tab){
      this.clearPendingTabClick();
      const index=this.tabs.findIndex(candidate=>candidate.id===tab?.id);
      if(index>=0)this.removeTab(index);
    },
    tabClick(tab) {
      if(this.reviewState.deleteQueuePending>0)return;
      // A folder tab selection is a source switch. Never keep a previous
      // source's review state/error visible under the newly selected tab.
      if(this.reviewMode && this.activeTabId!==tab.id){
        this.exitReview();
      }
      if(!this.reviewMode)this.reviewError="";
      const changeDirectoryMode=this.directoryMode && this.activeTabId!==tab.id;
      if(changeDirectoryMode)this.directorySelected=null;
      this.activeTabId = tab.id;
      if(changeDirectoryMode)
        window.iina?.postMessage("directory-mode",{enabled:true,root:tab.path});
      if (!tab.files.length) {
        window.iina?.postMessage("get-files", { path: tab.path, currentPath: tab.currentPath, tabId: tab.id });
      }
    },
    chooseFolder() {
      window.iina?.postMessage("choose-folder");
    },
    removeTab(index) {
      if(this.reviewState.deleteQueuePending>0)return;
      this.clearPendingTabClick();
      const removedTab = this.tabs[index];
      if(!removedTab)return;
      if(this.reviewMode && removedTab && this.activeTabId===removedTab.id){
        this.exitReview();
      }
      this.tabs.splice(index, 1);
      if (this.activeTabId === removedTab.id) {
        this.directorySelected=null;
        if (this.tabs.length) {
          let activeTab = this.tabs[0];
          this.activeTabId = activeTab.id;
          if(this.directoryMode)window.iina?.postMessage("directory-mode",{enabled:true,root:activeTab.path});
          window.iina?.postMessage("get-files", { path: activeTab.path, currentPath: activeTab.currentPath, tabId: activeTab.id });
        } else {
          this.activeTabId = null;
          if(this.directoryMode){
            this.directoryMode=false;
            window.iina?.postMessage("directory-mode",{enabled:false});
          }
        }
      }
      this.persistTabData();
    },
    toggleDirectoryMode(){
      if(!this.activeTab || !window.iina?.postMessage)return;
      this.directorySelected=null;
      this.directoryNotice="";
      this.directoryDeleteUnknown=false;
      if(this.directoryMode){
        this.directoryMode=false;
        window.iina.postMessage("directory-mode",{enabled:false});
      }else{
        window.iina.postMessage("directory-mode",{
          enabled:true,root:this.activeTab.path
        });
      }
    },
    enterDirectoryItem(item){
      if(!this.directoryMode || !item?.isDir || this.directoryDeleting)return;
      const tab=this.activeTab;
      if(!tab)return;
      tab.currentPath=item.path;
      this.directorySelected=null;
      window.iina?.postMessage("get-files",{
        path:tab.path,currentPath:tab.currentPath,tabId:tab.id
      });
    },
    requestDirectoryDelete(){
      const tab=this.activeTab,selected=this.directorySelected;
      if(!this.directoryMode || !tab || !selected || this.directoryDeleting ||
         selected.parent!==tab.currentPath || !window.iina?.postMessage)return;
      this.directoryDeleting=true;
      this.directoryNotice="Checking SMB target and requesting two confirmations…";
      window.iina.postMessage("directory-delete",{
        root:tab.path,parent:tab.currentPath,name:selected.name
      });
    },
    reconcileDirectoryDelete(){
      if(!this.directoryMode||this.directoryDeleting||!window.iina?.postMessage)return;
      this.directoryDeleting=true;
      window.iina.postMessage("directory-delete-reconcile",{});
    },
    handleItemClick(item) {
      if(this.directoryMode){
        if(this.directoryDeleting)return;
        if(item?.isDir && item.filename===".."){
          this.enterDirectoryItem(item);
        }else if(item?.isDir){
          this.directorySelected={name:item.filename,parent:this.activeTab?.currentPath,path:item.path};
        }
        return;
      }
      if (item.isDir) {
        const tab = this.activeTab;
        if (tab) {
          tab.currentPath = item.path;
          window.iina?.postMessage("get-files", { path: tab.path, currentPath: tab.currentPath, tabId: tab.id });
        }
      } else {
        const tab = this.activeTab;
        if (tab) {
          window.iina?.postMessage("open-file", { path: item.path });
        }
      }
    },
    persistTabData() {
      localStorage.setItem("tabs", JSON.stringify(this.tabs.map(tab => {
        return {
          id: tab.id,
          name: tab.name,
          path: tab.path,
          currentPath: tab.path,
          files: []
        }
      })));
    },
    loadTabData() {
      // Corrupt localStorage must not prevent the entire Vue sidebar mounting.
      try {
        const raw=JSON.parse(localStorage.getItem("tabs")||"[]");
        this.tabs=Array.isArray(raw)?raw.filter(tab=>tab &&
          typeof tab.id==="number" && typeof tab.path==="string" &&
          typeof tab.name==="string" && typeof tab.currentPath==="string"
        ).map(tab=>({...tab,files:[]})):[];
      }catch(error){
        this.tabs=[];
      }
      if (this.activeTabId == null && this.tabs.length) {
        this.tabClick(this.tabs[0]);
      }
    },
  },
  mounted() {
    this.loadDebugLog();
    this.logDebug("ui.mounted");
    this.debugErrorHandler=()=>this.logDebug("ui.runtime.error",{},"error");
    this.debugRejectionHandler=()=>this.logDebug("ui.promise.rejected",{},"error");
    window.addEventListener?.("error",this.debugErrorHandler);
    window.addEventListener?.("unhandledrejection",this.debugRejectionHandler);
    this.reviewKeyHandler=(event)=>this.handleSidebarKeydown(event);
    window.addEventListener?.("keydown",this.reviewKeyHandler);
    this.loadTabData();
    if (window.iina) {
      window.iina.onMessage("review-cancel-exit-complete", () => {
        this.exitReview(true);
      });
      window.iina.onMessage("review-end-exit-complete", () => {
        this.showSavedReviewDetails=false;
        this.exitReview(true);
      });
      window.iina.onMessage("review-discard-result",result=>{
        if(result?.status==="DISCARDED"){
          this.reviewError="";
          this.showSavedReviewDetails=false;
          return;
        }
        const reason=result?.reason;
        this.reviewError=reason==="UNRESOLVED_DELETE_JOBS"?
          `无法丢弃 Checkpoint：仍有未解决的删除任务（UNKNOWN ${result.unknown||0}，PAUSED ${result.paused||0}）。请手动恢复审核并核对；进度与删除记录均已保留。`:
          reason==="REVIEW_ACTIVE"?"请先结束 Review，再丢弃已保存的进度。":
          reason==="RESUME_PENDING"?"正在验证旧 Review，请完成后再操作。":
          "Checkpoint 未清除（"+(reason||"UNKNOWN_REJECTION")+"）。请查看日志。";
        this.showSavedReviewDetails=true;
        this.discardConfirming=false;
        this.logDebug("ui.review.discard_refused",{
          reason:["UNRESOLVED_DELETE_JOBS","REVIEW_ACTIVE","RESUME_PENDING","CHECKPOINT_SAVE_FAILED"].includes(reason)?reason:"OTHER"
        },"warn");
      });
      window.iina.onMessage("selected-folder", (path) => {
        this.newFolderPath = path;
        if (!this.newFolderName.trim()) {
          const folderName = path.split("/").pop() || "New Folder";
          let uniqueName = folderName;
          let counter = 1;
          while (this.tabs.some(t => t.name === uniqueName)) {
            uniqueName = `${folderName} (${counter++})`;
          }
          this.newFolderName = uniqueName;
        }
      });
      window.iina.onMessage("directory-mode-state",data=>{
        const tab=this.activeTab;
        this.directoryMode=data?.enabled===true && data.root===tab?.path;
        this.directorySelected=null;
        this.directoryDeleting=false;
        this.directoryNotice=this.directoryMode?"Directory mode enabled. Choose a subfolder.":(
          data?.reason?"Directory mode unavailable ("+data.reason+"). Finish or discard saved Review first.":"");
      });
      window.iina.onMessage("directory-delete-result",result=>{
        this.directoryDeleting=false;
        const status=typeof result?.status==="string"?result.status:"UNKNOWN";
        this.directoryDeleteUnknown=status==="UNKNOWN" ||
          result?.reason==="PREVIOUS_DELETE_UNKNOWN";
        this.directoryNotice=status==="DELETED"?
          (result?.observedAbsent===true?
            "Folder removed. SMB listing confirms it is absent.":
            "/bin/rm exit 0; folder absence is not independently confirmed. Check Finder."):
          status==="CANCELLED"?"Directory deletion cancelled.":
          status==="RECONCILED"?"Missing directory reconciled; no deletion retried.":
          status==="UNKNOWN"?
            (result?.reason==="RM_EXIT_NONZERO_MAY_BE_PARTIAL"?
              "Recursive delete exited "+result.exitCode+
              "; SOME CONTENTS MAY ALREADY BE DELETED. Do not retry. Inspect Finder.":
              "Directory deletion outcome UNKNOWN; partial deletion is possible. Do not retry."):
          "Directory deletion blocked ("+(result?.reason||status)+").";
        if(status==="DELETED"||status==="RECONCILED"){
          this.directorySelected=null;
          const tab=this.activeTab;
          if(tab)window.iina?.postMessage("get-files",{
            path:tab.path,currentPath:tab.currentPath,tabId:tab.id
          });
        }
      });
      window.iina.onMessage("files-list", (data) => {
        const tab = this.tabs.find((t) => t.id === data.tabId);
        if (tab) {
          tab.files = data.files;
        }
      });
      window.iina.onMessage("playing-file", (data) => {
        this.logDebug("ui.player.file_loaded");
        if (data.startsWith("file://")) {
          this.activePlayFilePath = data.substring(7);
        }
      });
      window.iina.onMessage("review-scan-progress", data => {
        if(!this.reviewPending || !this.reviewMode)return;
        const directories=Number.isInteger(data?.directories)?data.directories:0;
        const videos=Number.isInteger(data?.files)?data.files:0;
        this.reviewError="Scanning NAS subfolders… "+directories+
          " directories, "+videos+" videos. Use Folders to cancel.";
      });
      window.iina.onMessage("review-window-data",data=>this.applyReviewWindow(data));
      window.iina.onMessage("nas-backup-status",data=>{
        if(data?.root!==this.reviewState.root)return;
        if(["disabled","pending","synced","conflict"].includes(data.status))
          this.reviewState.nasBackupStatus=data.status;
        this.reviewState.nasBackupEnabled=data.enabled===true;
      });
      window.iina.onMessage("review-state", data => {
        const phase=["IDLE","ACTIVE","COMPLETE","ERROR"].includes(data.phase) ?
          data.phase:(data.error?"ERROR":data.active===true?"ACTIVE":"IDLE");
        this.logDebug("ui.review.state_received",{
          total:Number.isInteger(data.totalCount)?data.totalCount:Array.isArray(data.entries)?data.entries.length:0,
          active:data.active===true,
          success:phase!=="ERROR",
          status:phase
        },phase==="ERROR"?"warn":"info");
        this.clearReviewTimer();
        this.reviewPending=false;
        const before=this.reviewState;
        const sessionEpoch=Number.isSafeInteger(data.sessionEpoch)?
          data.sessionEpoch:0;
        const sameSession=(before.active===true||before.phase==="COMPLETE") &&
          (data.active===true||phase==="COMPLETE") &&
          before.root===data.root && before.sessionEpoch===sessionEpoch;
        if(!sameSession)this.resetReviewBrowsing();
        const playingChanged=sameSession &&
          Number.isInteger(data.playingPosition)&&data.playingPosition>=0 &&
          before.playingPosition!==data.playingPosition &&
          data.playbackStatus!=="awaiting_file_loaded";
        // A new loaded player video is a stronger follow signal than the
        // user's earlier manual scrolling. Only status/cursor changes keep
        // manual browsing in place.
        if(playingChanged)this.resetReviewBrowsing();
        // A progress update can arrive while the user browses page 700,
        // even if IINA is playing page 20. Keep the visible page and ask
        // for refreshed statuses instead of yanking the scrollbar home.
        const keepBrowsing=sameSession&&this.reviewManualBrowsing &&
          before.entries.length>0 &&
          Number(data.totalCount)>(
            Array.isArray(data.entries)?data.entries.length:0);
        this.reviewState={
          entries:keepBrowsing?before.entries:
            (Array.isArray(data.entries)?data.entries:[]),
          cursor:Number.isInteger(data.cursor)?data.cursor:-1,
          playingPosition:Number.isInteger(data.playingPosition)?data.playingPosition:-1,
          active:data.active===true,
          sessionEpoch,
          viewRevision:Number.isSafeInteger(data.viewRevision)?data.viewRevision:0,
          root:typeof data.root==="string"?data.root:"",
          phase,
          nasReadOnly:data.nasReadOnly===true,
          recursive:data.recursive===true,
          deletionSupported:data.deletionSupported===true,
          deleteRecoveryPending:data.deleteRecoveryPending===true,
          deleteInFlight:data.deleteInFlight===true,
          deleteQueuePending:Number.isInteger(data.deleteQueuePending)?data.deleteQueuePending:0,
          deleteQueuePaused:Number.isInteger(data.deleteQueuePaused)?data.deleteQueuePaused:0,
          deleteQueueBlocked:data.deleteQueueBlocked===true,
          deleteQueueStatus:["IDLE","WORKING","PAUSED","BLOCKED",
            "COMPLETE","COMPLETE_WITH_WARNINGS"].includes(data.deleteQueueStatus)?
            data.deleteQueueStatus:"IDLE",
          deleteQueueCanClose:data.deleteQueueCanClose===true &&
            ["COMPLETE","COMPLETE_WITH_WARNINGS"].includes(data.deleteQueueStatus),
          deleteQueueRunning:Number.isInteger(data.deleteQueueRunning)?data.deleteQueueRunning:0,
          deleteQueueWaiting:Number.isInteger(data.deleteQueueWaiting)?data.deleteQueueWaiting:0,
          deleteQueueUnknown:Number.isInteger(data.deleteQueueUnknown)?data.deleteQueueUnknown:0,
          deleteQueueDeleted:Number.isInteger(data.deleteQueueDeleted)?data.deleteQueueDeleted:0,
          deleteQueueFailed:Number.isInteger(data.deleteQueueFailed)?data.deleteQueueFailed:0,
          deleteQueueReconciled:Number.isInteger(data.deleteQueueReconciled)?data.deleteQueueReconciled:0,
          deleteQueueCancelled:Number.isInteger(data.deleteQueueCancelled)?data.deleteQueueCancelled:0,
          deleteQueueNotice:typeof data.deleteQueueNotice==="string"?data.deleteQueueNotice:"",
          totalCount:Number.isInteger(data.totalCount)?data.totalCount:
            (Array.isArray(data.entries)?data.entries.length:0),
          // Keep the immutable snapshot total for window indices and display
          // a separate live inventory count after confirmed removals.
          remainingCount:Number.isInteger(data.remainingCount)&&data.remainingCount>=0?
            data.remainingCount:Math.max(0,
              (Number.isInteger(data.totalCount)?data.totalCount:
                (Array.isArray(data.entries)?data.entries.length:0))-
              (Number.isInteger(data.deletedCount)?data.deletedCount:0)-
              (Number.isInteger(data.missingCount)?data.missingCount:0)),
          keptCount:Number.isInteger(data.keptCount)?data.keptCount:
            (Array.isArray(data.entries)?data.entries.filter(e=>e.status==="KEEP").length:0),
          deletedCount:Number.isInteger(data.deletedCount)?data.deletedCount:0,
          missingCount:Number.isInteger(data.missingCount)?data.missingCount:0,
          windowStart:keepBrowsing?before.windowStart:
            (Number.isInteger(data.windowStart)?data.windowStart:0),
          playbackMatched:data.playbackMatched===true,
          playbackCanAttach:data.playbackCanAttach===true,
          playbackLoadFailed:data.playbackLoadFailed===true,
          playbackStatus:typeof data.playbackStatus==="string"?data.playbackStatus:"unknown",
          kShortcutEnabled:data.kShortcutEnabled===true,
          kRegistration:typeof data.kRegistration==="string"?data.kRegistration:"Unknown",
          kInputEvents:Number.isInteger(data.kInputEvents)?data.kInputEvents:0,
          lastKResult:typeof data.lastKResult==="string"?data.lastKResult:"None",
          resumeAvailable:data.resumeAvailable===true,
          autoResumeSuspended:data.autoResumeSuspended===true,
          resumeTotal:Number.isInteger(data.resumeTotal)?data.resumeTotal:0,
          resumeKept:Number.isInteger(data.resumeKept)?data.resumeKept:0,
          resumeKind:data.resumeKind==="smb"?"smb":"local",
          resumeSource:typeof data.resumeSource==="string" &&
            (data.resumeSource.startsWith("/private/tmp/iina-nas-review-fixture-")||
             data.resumeSource.startsWith("/Volumes/")) ?
            data.resumeSource:"",
          nasBackupEnabled:data.nasBackupEnabled===true,
          nasBackupStatus:typeof data.nasBackupStatus==="string"?
            data.nasBackupStatus:"disabled"
        };
        if(this.reviewState.active)this.reviewMode=true;
        if(this.reviewState.active || !this.reviewState.resumeAvailable)
          this.showSavedReviewDetails=false;
        if(keepBrowsing && !this.reviewWindowPending)
          this.requestReviewWindow(this.reviewState.windowStart);
        const focusIndex=this.reviewState.playingPosition>=0?
          this.reviewState.playingPosition:this.reviewState.cursor;
        const centerKey=this.reviewMode&&!this.reviewManualBrowsing&&focusIndex>=0?
          this.reviewState.root+":"+focusIndex+":"+this.reviewState.windowStart:"";
        if(centerKey && centerKey!==this.reviewCenteredKey){
          this.reviewCenteredKey=centerKey;
          this.centerReviewAfterRender();
        }else if(!centerKey)this.reviewCenteredKey="";
        if(!this.reviewState.resumeAvailable || this.reviewState.active)
          this.discardConfirming=false;
        this.reviewError=typeof data.error==="string"?data.error:"";
        this.reviewNotice=phase==="COMPLETE" ?
          (this.reviewState.deletedCount>0 || this.reviewState.missingCount>0 ?
            "Review complete. "+this.reviewState.keptCount+
            " kept, "+this.reviewState.deletedCount+" deleted, "+
            this.reviewState.missingCount+" missing." :
            "Review complete. All "+this.reviewState.keptCount+" videos kept.") :
          this.reviewState.active && this.reviewState.playbackStatus==="awaiting_file_loaded" ?
            "Waiting for IINA to finish loading the next Review video. KEEP is blocked until file-loaded; if loading stalls, explicitly Reopen current Review item." :
          this.reviewState.active && !this.reviewState.playbackMatched &&
            ["different_review_item","other_local_fixture","other_media","non_file_url","non_local_url","invalid_file_url"].includes(this.reviewState.playbackStatus) ?
            "Player is on a different video. If it is another fully loaded pending queue item, physical K or verified natural EOF will KEEP that item while leaving skipped items pending. Otherwise select Reopen current Review item." :
          this.reviewState.active && !this.reviewState.playbackMatched ?
            "Review queue is ready. Use IINA History to retain playback position, or explicitly Reopen current Review item to open the pending video." :
          this.reviewState.active ?
            "Review attached to this IINA video; IINA manages playback history and position." : "";
      });
      try{window.iina.postMessage("review-ready",{});}catch(_){
        this.logDebug("ui.review.bridge_unavailable",{},"warn");
      }
      window.iina.onMessage("debug-event",entry=>this.appendDebugEvent(entry));
      window.iina.onMessage("debug-snapshot",entries=>{
        if(Array.isArray(entries))for(const entry of entries.slice(-200))this.appendDebugEvent(entry);
      });
      try{window.iina.postMessage("debug-ready",{});}catch(_){
        this.logDebug("ui.debug.bridge_failed",{},"warn");
      }
    }else{
      this.logDebug("ui.bridge.unavailable",{},"warn");
    }
  },
  beforeUnmount(){
    this.clearPendingTabClick();
    this.clearReviewTimer();
    this.clearReviewWindowTimer();
    if(this.reviewKeyHandler)window.removeEventListener?.("keydown",this.reviewKeyHandler);
    if(this.debugErrorHandler)window.removeEventListener?.("error",this.debugErrorHandler);
    if(this.debugRejectionHandler)window.removeEventListener?.("unhandledrejection",this.debugRejectionHandler);
  },
};
</script>

<style lang="scss">
.review-item-play {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  color: inherit;
  border: 0;
  background: transparent;
  cursor: pointer;
  padding: 8px 5px;
  font: inherit;
  span { min-width: 0; overflow-wrap: anywhere; }
  .review-entry-name { flex: 1; min-width: 0; }
  .review-entry-status {
    flex-shrink: 0;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .review-playing-label {
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
    color: #b8edff;
  }
  small { flex-shrink: 0; }
  &:hover:not(:disabled), &:focus-visible { background: rgba(126,155,227,.18); }
  &:disabled { cursor: not-allowed; opacity: .55; }
}
.review-scan-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px;
  margin-bottom: 6px;
  border-bottom: 1px solid #414958;
  color: #d8e2f4;
  font-size: 12px;
  cursor: pointer;
  input { accent-color: #7e9be3; }
}
.review-switch {
  border: 1px solid #737785;
  border-radius: 6px;
  color: #e6ebf5;
  background: #303644;
  padding: 5px 10px;
  cursor: pointer;
  flex-shrink: 0;
  &:disabled { opacity: .4; cursor: default; }
}
.review-panel {
  padding: 8px;
  h3 { margin: 0 0 6px; }
  p { line-height: 1.4; font-size: 12px; }
  .review-heading { display:flex; align-items:center; gap:8px; font-size:17px; }
  .review-source {
    color:#abbdd4; font-size:10px; font-weight:600; letter-spacing:.03em;
    padding:2px 6px; border:1px solid #526076; border-radius:5px;
  }
  .review-metrics {
    display:grid; grid-template-columns:repeat(3,minmax(0,1fr));
    gap:7px; margin:9px 0 10px;
  }
  .review-metric {
    min-width:0; padding:9px 10px 8px; background:#2b323f;
    border:1px solid #475368; border-radius:8px;
    display:flex; flex-direction:column; gap:2px;
  }
  .review-metric strong {
    font-size:19px; font-variant-numeric:tabular-nums; line-height:1.2;
    color:#f4f7fd; overflow-wrap:anywhere;
  }
  .review-metric span {font-size:11px; color:#b3c1d5;}
  .review-primary-actions {
    display:grid; grid-template-columns:repeat(2,minmax(0,1fr));
    gap:8px; margin:0 0 5px;
  }
  .review-primary-actions .review-switch {
    width:100%; min-width:0; min-height:40px; padding:9px 6px;
    text-align:center; white-space:normal; line-height:1.25;
    font-weight:650; font-size:12px;
  }
  .review-action-keep { background:#374b68; border-color:#6582ae; }
  .review-action-delete { background:#383842; border-color:#737785; }
  .review-compact-option {
    border-bottom:0; padding:6px 2px 8px; margin-bottom:0;
    color:#bcc8d9; line-height:1.3; font-size:11px;
  }
  .review-compact-option input {width:16px; height:16px; margin:0; flex-shrink:0;}
  .review-context-notice {
    margin:6px 0; color:#cad8ea; font-size:12px;
  }
  .review-list-toolbar {
    display:flex; align-items:center; justify-content:space-between;
    flex-wrap:wrap; gap:8px; margin:13px 0 4px;
  }
  .review-list-meta {
    min-width:0; display:flex; flex-direction:column; gap:2px;
  }
  .review-list-meta strong {font-size:13px; color:#eaf0fb;}
  .review-list-meta span {font-size:11px; color:#a9bad2; line-height:1.35;}
  .review-tool-button {
    font-size:11px; padding:5px 10px; min-height:32px;
    background:transparent; border-color:#66748a;
  }
  .review-more {margin:10px 0 5px; border-top:1px solid #465163;}
  .review-more summary {
    color:#b9cae0; font-size:12px; cursor:pointer; padding:12px 3px;
    border-radius:5px; list-style:disclosure-closed;
  }
  .review-more[open] summary {list-style:disclosure-open;}
  .review-more summary:focus-visible,
  .review-switch:focus-visible {
    outline:2px solid #a6c9ff; outline-offset:2px;
  }
  .review-more-content {
    padding:2px 8px 10px; background:rgba(20,25,33,.23);
    border-radius:7px;
  }
  .review-more-section {padding:10px 0; border-bottom:1px solid #475160;}
  .review-more-section:last-child {border-bottom:0;}
  .review-more-section > strong {font-size:12px; color:#e1e9f6;}
  .review-more-section p {margin:7px 0 0; color:#aebfd5;}
  .review-more-controls {
    display:flex; align-items:center; flex-wrap:wrap; gap:8px;
    margin-top:8px; font-size:11px; color:#b7c7db;
  }
  .review-shortcut { color: #a8b9d2; }
  .review-error { color: #ffce82; }
  .delete-queue-status {
    border:1px solid #485363; border-radius:8px;
    padding:10px 12px; margin:5px 0 8px;
    background:#292f39; font-size:12px; line-height:1.35;
  }
  .delete-queue-heading {display:flex; align-items:center; gap:8px;}
  .delete-queue-dot {
    display:inline-block; flex-shrink:0; width:8px; height:8px;
    border-radius:50%; background:#95a5b9;
  }
  .delete-queue-status strong {display:block; font-size:13px; line-height:1.3;}
  .delete-queue-status p {margin:4px 0 0 16px; color:#b7c2d0;}
  .delete-queue-status.queue-complete .delete-queue-dot {background:#a5deb3;}
  .delete-queue-status.queue-working .delete-queue-dot {background:#b5d2ff;}
  .delete-queue-status.queue-paused .delete-queue-dot,
  .delete-queue-status.queue-blocked .delete-queue-dot,
  .delete-queue-status.queue-complete_with_warnings .delete-queue-dot {
    background:#ffce82;
  }
  .delete-queue-status.queue-complete strong { color: #a5deb3; }
  .delete-queue-status.queue-working strong { color: #b5d2ff; }
  .delete-queue-status.queue-paused strong,
  .delete-queue-status.queue-blocked strong,
  .delete-queue-status.queue-complete_with_warnings strong { color: #ffce82; }
  .review-files {
    list-style: none;
    height: 56vh;
    max-height: 660px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0;
    margin: 12px 0;
    border: 1px solid #4a5260;
    border-radius: 8px;
  }
  .review-files::before,.review-files::after {
    content: "";
    display: block;
    height: calc(min(26vh,260px) - 24px);
    min-height: 0;
    pointer-events: none;
  }
  li { padding: 8px; border-bottom: 1px solid #444; overflow-wrap: anywhere; }
  li.current { background: #394a60; }
  li.playing {
    background: #24556b;
    box-shadow: inset 4px 0 #78d6ff;
    outline: 1px solid rgba(120,214,255,.28);
  }
  li.playing.current { background: #28607a; }
  li.playing .review-item-play { color: #ffffff; font-weight: 600; }
  small { color: #afb7c7; padding-left: 8px; }
}
.debug-panel {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 100%;
  h3 { margin: 0; font-size: 17px; }
  p { margin: 0; color: #c4c8d0; font-size: 12px; }
  .debug-actions { display:flex; align-items:center; gap: 7px; flex-wrap: wrap; }
  .debug-status { color: #abd4ff; }
  .debug-output {
    box-sizing: border-box;
    flex: 1;
    min-height: 280px;
    width: 100%;
    background: #15191f;
    color: #d9e3f2;
    border: 1px solid #48515f;
    border-radius: 6px;
    resize: vertical;
    padding: 10px;
    font: 11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
    white-space: pre;
    overflow: auto;
  }
}
.resume-banner {
  padding: 12px;
  margin-bottom: 10px;
  border: 1px solid #646a75;
  background: #303640;
  border-radius: 8px;
  color: #e4eaf3;
  strong { font-size: 13px; }
  p { line-height: 1.45; color: #b6c1d0; font-size: 12px; }
  .resume-warning { color: #ffce82; }
  .debug-actions { display: flex; gap: 8px; flex-wrap: wrap; }
}
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  color: #ddd;
}

.header {
  display: flex;
  align-items: center;
  padding: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: transparent;
}

.add-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.6);
  color: #ffffff;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 10px;
  flex-shrink: 0;
  transition: all 0.2s;

  &:hover {
    background: rgba(255, 255, 255, 0.08);
  }
}

.tabs-wrapper {
  display: flex;
  overflow-x: auto;
  gap: 6px;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
}

.tab-item {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px;
  white-space: nowrap;
  cursor: pointer;
  display: flex;
  align-items: center;
  position: relative;
  font-size: 12px;
  color: #ddd;
  transition: all 0.2s;

  &.active {
    background: transparent;
    border-color: rgba(255, 255, 255, 0.9);
    color: #fff;
  }

  &:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .close-btn {
    margin-left: 6px;
    opacity: 0;
    transition: opacity 0.2s;
    font-size: 14px;
  }

  &:hover .close-btn {
    opacity: 1;
  }
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 4px;
  font-size: 11px;
  color: #888;
  border-bottom: 1px solid #333;

  .back-btn {
    background: #444;
    border: none;
    color: #eee;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
    &:hover {
      background: #555;
    }
  }

  .current-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.file-item {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;

  &.active {
    background: #007aff;
  }

  &:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .file-icon {
    margin-right: 8px;
    font-size: 16px;
  }

  .file-name {
    color: white;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #888;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 100;
}

.modal-content {
  background: #2c2c2c;
  padding: 16px;
  border-radius: 8px;
  width: 280px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);

  h3 {
    margin-top: 0;
    font-size: 16px;
    margin-bottom: 16px;
  }
}

.form-group {
  margin-bottom: 12px;
  label {
    display: block;
    font-size: 12px;
    margin-bottom: 4px;
    color: #aaa;
  }
  input {
    width: 100%;
    background: #1e1e1e;
    border: 1px solid #444;
    color: white;
    padding: 6px 8px;
    border-radius: 4px;
    outline: none;
    font-size: 13px;
  }
  .error-msg {
    color: #ff4d4f;
    font-size: 11px;
    margin-top: 4px;
    display: block;
  }
}

.path-select-group {
  display: flex;
  gap: 8px;
  input {
    flex: 1;
    cursor: default;
  }
  button {
    background: #444;
    border: none;
    color: white;
    padding: 0 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
    &:hover {
      background: #555;
    }
  }
}

.path-input-group {
  display: flex;
  gap: 4px;
  button {
    background: #444;
    border: none;
    color: white;
    padding: 0 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;

  button {
    background: transparent;
    border: 1px solid #444;
    color: #ccc;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;

    &.primary {
      background: #007aff;
      border-color: #007aff;
      color: white;

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
  }
}
</style>
