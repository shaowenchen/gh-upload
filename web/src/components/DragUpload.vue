<template>
  <div class="file-drag">
    <div class="upload">
      <ul v-if="files.length">
        <table class="file-table">
          <tr>
            <th>File</th>
            <th>Size</th>
            <th>Status</th>
          </tr>
          <tr v-for="file in files" :key="file.id">
            <td>
              <span>{{ file.name }}</span>
            </td>
            <td>
              <span>{{ humansize(file.size) }}</span>
            </td>
            <td>
              <span v-if="file.error">{{ file.error }}</span>
              <span v-else-if="file.success"
                ><button
                  class="btn btn-sm btn-success"
                  type="button"
                  @click="doCopy(file.response.data.download_url)"
                >
                  Copy
                </button></span
              >
              <span v-else-if="file.active">Uploading</span>
              <span v-else></span>
            </td>
          </tr>
        </table>
      </ul>
      <ul v-else>
        <div class="text-center">
          <h4>Drop files to upload<br />or</h4>
          <label for="file" class="btn btn-lg btn-primary">Select Files</label>
        </div>
      </ul>

      <div v-show="$refs.upload && $refs.upload.dropActive" class="drop-active">
        <h3>Drop files to upload</h3>
      </div>

      <div class="example-btn">
        <file-upload
          class="btn btn-primary"
          post-action="https://uploadapi.chenshaowen.com/api/v1/files"
          :multiple="true"
          :drop="true"
          :drop-directory="true"
          v-model="files"
          ref="upload"
        >
          <i class="fa fa-plus"></i>
          Select files
        </file-upload>
        <button
          type="button"
          class="btn btn-success"
          v-if="!$refs.upload || !$refs.upload.active"
          @click.prevent="$refs.upload.active = true"
        >
          <i class="fa fa-arrow-up" aria-hidden="true"></i>
          Start Upload
        </button>
        <button
          type="button"
          class="btn btn-danger"
          v-else
          @click.prevent="$refs.upload.active = false"
        >
          <i class="fa fa-stop" aria-hidden="true"></i>
          Stop Upload
        </button>
      </div>
    </div>
  </div>
</template>
<style>
.file-drag label.btn {
  margin-bottom: 0;
  margin-right: 1rem;
}
.file-drag .drop-active {
  top: 0;
  bottom: 0;
  right: 0;
  left: 0;
  position: fixed;
  z-index: 9999;
  opacity: 0.6;
  text-align: center;
  background: #000;
}
.file-drag .drop-active h3 {
  margin: -0.5em 0 0;
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  -webkit-transform: translateY(-50%);
  -ms-transform: translateY(-50%);
  transform: translateY(-50%);
  font-size: 40px;
  color: #fff;
  padding: 0;
}
.file-drag li {
  list-style: none;
}
.file-table {
  border-collapse: collapse;
  margin-left: auto;
  margin-right: auto;
}

.file-table td,
.file-table th {
  border: 1px solid #ddd;
  padding: 4px;
}

.file-table tr:nth-child(even) {
  background-color: #f2f2f2;
}

.file-table tr:hover {
  background-color: #ddd;
}

.file-table th {
  padding-top: 4px;
  padding-bottom: 4px;
  text-align: left;
  background-color: #6c757d;
  color: white;
}

.file-table td {
  padding-top: 4px;
  padding-bottom: 4px;
  text-align: left;
}
</style>

<script>
import FileUpload from "vue-upload-component";
import { copyText } from "vue3-clipboard";
export default {
  name: "DragUpload",
  components: {
    FileUpload,
  },
  data() {
    return {
      files: [],
    };
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
    downloadlink: function (uri) {
      return uri;
    },
    doCopy: function (uri) {
      copyText(this.downloadlink(uri), undefined, (error, event) => {
        if (error) {
          alert("I lost it!");
        } else {
          alert("I got it! " + this.downloadlink(uri));
        }
        console.log(event);
      });
    },
  },
};
</script>
