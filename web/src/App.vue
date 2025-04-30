<template>
  <DragUpload />
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
  created: function () {
    this.updateFileList();
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
      axios.get("https://uploadapi.chenshaowen.com/api/v1/files").then((response) => {
        this.filelist = response.data.data.list;
      });
    },
    clearFiles: function () {
      axios.get("https://uploadapi.chenshaowen.com/api/v1/clear").then(() => {
        this.updateFileList();
      }).catch(error => {
        console.error("Error clearing files:", error);
        alert("Failed to clear files");
      });
    }
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
</style>
