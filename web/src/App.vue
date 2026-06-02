<template>
  <DragUpload :uploadURL="uploadURL" />
  <div class="script-container">
    <div class="script-header">
      <div>
        <h3>CLI Upload</h3>
        <p>Use this script to upload from terminal. Large files are split by the server automatically.</p>
      </div>
      <button @click="copyUploadScript" class="copy-script-btn">Copy Script</button>
    </div>
    <pre class="script-block"><code>{{ uploadScript }}</code></pre>
  </div>
  <div class="table-container" v-show="tableVisible">
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Size</th>
          <th>Link</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="file in filelist" :key="file.name">
          <td>
            {{ file.name }}
          </td>
          <td>
            {{ humansize(file.size) }}
          </td>
          <td>
            <a :href="file.download_url" target="_blank">Open</a>
          </td>
        </tr>
      </tbody>
    </table>
    <div style="margin-top: 20px; text-align: right;">
      <button @click="clearFiles" style="padding: 8px 16px; background-color: #808080; color: white; border: none; border-radius: 4px; cursor: pointer;">Clear</button>
    </div>
  </div>
</template>

<script>
import axios from "axios";
import DragUpload from "./components/DragUpload.vue";

export default {
  name: "App",
  data() {
    return {
      filelist: [],
      tableVisible: false,
      apiBaseURL: window.location.origin,
      uploadURL: window.location.origin + "/api/v1/files",
    };
  },
  components: {
    DragUpload,
  },
  watch: {
    filelist: function () {
      this.tableVisible = this.filelist.length > 0;
    },
  },
  created: async function () {
    await this.loadConfig();
    this.updateFileList();
  },
  computed: {
    uploadScript: function () {
      return `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: gh-upload <file>"
  exit 1
fi

curl -sS -F "file=@$1" "${this.apiBaseURL}/api/v1/files"`;
    },
  },
  methods: {
    humansize: function (size) {
      if (size > 1024 * 1024 * 1024 * 1024) {
        return (size / 1024 / 1024 / 1024 / 1024).toFixed(2) + " TB";
      } else if (size > 1024 * 1024 * 1024) {
        return (size / 1024 / 1024 / 1024).toFixed(2) + " GB";
      } else if (size > 1024 * 1024) {
        return (size / 1024 / 1024).toFixed(2) + " MB";
      } else if (size > 1024) {
        return (size / 1024).toFixed(2) + " KB";
      }
      return size.toString() + " B";
    },
    updateFileList: function () {
      this.filelist = [];
      axios.get(this.apiBaseURL + "/api/v1/files").then((response) => {
        this.filelist = response.data.data.list;
      });
    },
    loadConfig: function () {
      return axios.get("/api/v1/config").then((response) => {
        const config = response.data.data;
        if (config.api_base_url) {
          this.apiBaseURL = config.api_base_url;
        }
        if (config.upload_url) {
          this.uploadURL = config.upload_url;
        }
      }).catch(error => {
        console.error("Error loading config:", error);
      });
    },
    clearFiles: function () {
      axios.get(this.apiBaseURL + "/api/v1/clear").then(() => {
        this.updateFileList();
      }).catch(error => {
        console.error("Error clearing files:", error);
        alert("Failed to clear files");
      });
    },
    copyUploadScript: function () {
      navigator.clipboard.writeText(this.uploadScript).then(() => {
        alert("Upload script copied");
      }).catch(() => {
        alert("Failed to copy upload script");
      });
    },
  },
};
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  margin-top: 60px;
}
.table-container {
  max-width: 600px;
  width: 100%;
  margin-left: auto;
  margin-right: auto;
  margin-top: 20px;
}
.script-container {
  max-width: 720px;
  width: calc(100% - 32px);
  margin: 24px auto;
  padding: 18px;
  text-align: left;
  background: #111827;
  border-radius: 12px;
  box-shadow: 0 14px 40px rgba(17, 24, 39, 0.18);
  color: #e5e7eb;
}
.script-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}
.script-header h3 {
  margin: 0 0 6px;
  color: #ffffff;
}
.script-header p {
  margin: 0 0 14px;
  color: #9ca3af;
}
.copy-script-btn {
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: #10b981;
  color: #ffffff;
  cursor: pointer;
  white-space: nowrap;
}
.script-block {
  margin: 0;
  padding: 14px;
  overflow-x: auto;
  background: #030712;
  border-radius: 8px;
  color: #d1fae5;
}
.table-container table {
  border-collapse: collapse;
  font-family: Tahoma, Geneva, sans-serif;
}
.table-container  table td {
  padding: 15px;
  max-width: 400px;
  overflow: hidden;
  width: 100%;
  text-align: center;
}
.table-container  table thead td {
  background-color: #0d6ffd;
  color: #ffffff;
  font-weight: bold;
  font-size: 13px;
  border: 1px solid #54585d;
}
.table-container table tbody td {
  color: #636363;
  border: 1px solid #dddfe1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.table-container table tbody tr {
  background-color: #f9fafb;
}
.table-container table tbody tr:nth-child(odd) {
  background-color: #ffffff;
}
@media (max-width: 640px) {
  .script-header {
    display: block;
  }

  .copy-script-btn {
    margin-bottom: 12px;
  }
}
</style>
