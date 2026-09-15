<template>
  <el-dialog class="subdomain-mailbox-dialog" :model-value="modelValue" :title="t('subdomainAdd')" width="min(640px, 94vw)" top="5vh"
             :close-on-click-modal="!submitting" :close-on-press-escape="!submitting" :show-close="!submitting"
             @update:model-value="emit('update:modelValue', $event)">
    <div v-loading="loading" class="subdomain-form">
      <p class="owner">{{ t('subdomainOwner', {email: userEmail || String(userId)}) }}</p>
      <el-alert :title="t('subdomainReceiveOnly')" type="info" :closable="false" />
      <el-alert v-if="!loading && !domains.length" :title="t('subdomainNone')" type="warning" :closable="false" />
      <el-form label-position="top" :disabled="submitting || !!pending">
        <el-form-item :label="t('subdomainDomain')">
          <el-select v-model="form.domain" filterable :placeholder="t('select')" style="width: 100%">
            <el-option v-for="domain in domains" :key="domain" :label="domain" :value="domain" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('subdomainMode')">
          <el-radio-group v-model="form.mode">
            <el-radio-button value="custom">{{ t('subdomainCustom') }}</el-radio-button>
            <el-radio-button value="random">{{ t('subdomainRandom') }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.mode === 'custom'" :label="t('subdomainPrefixes')">
          <el-input v-model="form.prefixes" type="textarea" :rows="3" :placeholder="t('subdomainPrefixPlaceholder')" />
        </el-form-item>
        <el-form-item v-else :label="t('subdomainCount')">
          <el-input-number v-model="form.count" :min="1" :max="100" :precision="0" />
        </el-form-item>
      </el-form>
      <p v-if="preview" class="preview">{{ preview }}</p>
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" />
      <el-alert v-if="outcome" :title="t('subdomainResult', {created: outcome.created, failed: outcome.failed})"
                :type="outcome.failed ? 'warning' : 'success'" :closable="false" />
      <el-table v-if="outcome" :data="outcome.items" max-height="260">
        <el-table-column prop="email" :label="t('emailAccount')" min-width="190" />
        <el-table-column :label="t('tabStatus')" min-width="160">
          <template #default="{row}">
            <span :class="row.status === 'created' ? 'created' : 'failed'">
              {{ row.status === 'created' ? t('subdomainCreated') : errorText(row.error) }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button v-if="expired" @click="newBatch">{{ t('subdomainReviewed') }}</el-button>
      <el-button v-else-if="outcome" @click="newBatch">{{ t('subdomainAnother') }}</el-button>
      <el-button v-else type="primary" :loading="submitting" :disabled="loading || (!pending && !domains.length)" @click="submit">
        {{ pending ? t('subdomainRetry') : t('add') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import {computed, reactive, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useUserStore} from '@/store/user.js'
import {userSubdomainDomains, userSubdomainBatchCreate} from '@/request/user.js'

const props = defineProps({modelValue: Boolean, userId: Number, userEmail: String})
const emit = defineEmits(['update:modelValue', 'created'])
const {t, te} = useI18n()
const userStore = useUserStore()
const loading = ref(false)
const submitting = ref(false)
const domains = ref([])
const pending = ref(null)
const pendingAt = ref(0)
const expired = ref(false)
const outcome = ref(null)
const notice = ref('')
const form = reactive({domain: '', mode: 'custom', prefixes: '', count: 1})
const prefixes = computed(() => form.prefixes.split(/\r?\n/).map(p => p.trim()).filter(Boolean))
const preview = computed(() => form.mode === 'custom' && prefixes.value.length === 1 && form.domain
  ? `${prefixes.value[0].toLowerCase()}@${form.domain}` : '')
const storageKey = computed(() => `subdomain-pending:${userStore.user.userId}:${props.userId}`)

function errorText(code) {
  return te(`subdomainErrors.${code}`) ? t(`subdomainErrors.${code}`) : t('subdomainRequestFailed')
}

function restoreForm(body) {
  form.domain = body.domain
  form.mode = body.prefixes ? 'custom' : 'random'
  form.prefixes = body.prefixes?.join('\n') || ''
  form.count = body.count || 1
}

watch(() => props.modelValue, async open => {
  if (!open) return
  const targetId = props.userId
  loading.value = true
  domains.value = []
  outcome.value = null
  notice.value = ''
  pending.value = null
  expired.value = false
  form.mode = 'custom'
  form.prefixes = props.userEmail?.split('@')[0] || ''
  form.count = 1
  form.domain = ''
  try {
    const saved = sessionStorage.getItem(storageKey.value)
    if (saved) {
      const {body, createdAt} = JSON.parse(saved)
      if (body?.userId === targetId && body.requestId) {
        pending.value = body
        pendingAt.value = createdAt
        restoreForm(body)
        expired.value = !createdAt || Date.now() - createdAt >= 86400000
        notice.value = t(expired.value ? 'subdomainExpired' : 'subdomainUncertain')
      }
    }
    const available = await userSubdomainDomains()
    if (props.userId !== targetId) return
    domains.value = available
    if (!pending.value) form.domain = available[0] || ''
  } catch {
    notice.value = t('subdomainLoadFailed')
  } finally {
    loading.value = false
  }
})

function newBatch() {
  sessionStorage.removeItem(storageKey.value)
  pending.value = null
  expired.value = false
  outcome.value = null
  notice.value = ''
  form.prefixes = ''
}

async function submit() {
  if (submitting.value) return
  if (pending.value && (!pendingAt.value || Date.now() - pendingAt.value >= 86400000)) {
    expired.value = true
    notice.value = t('subdomainExpired')
    return
  }
  const firstAttempt = !pending.value
  if (!pending.value) {
    if (!form.domain || (form.mode === 'custom' && (prefixes.value.length < 1 || prefixes.value.length > 100))
      || (form.mode === 'random' && (!Number.isInteger(form.count) || form.count < 1 || form.count > 100))) {
      notice.value = t('subdomainInvalidForm')
      return
    }
    const body = {requestId: crypto.randomUUID(), userId: props.userId, domain: form.domain,
      ...(form.mode === 'custom' ? {prefixes: [...prefixes.value]} : {count: form.count})}
    try {
      // Keep the exact request across dialog close, reload and uncertain network errors.
      pendingAt.value = Date.now()
      sessionStorage.setItem(storageKey.value, JSON.stringify({body, createdAt: pendingAt.value}))
      pending.value = body
    } catch {
      notice.value = t('subdomainStorageFailed')
      return
    }
  }
  submitting.value = true
  notice.value = ''
  try {
    const data = await userSubdomainBatchCreate(pending.value)
    if (data.status === 'processing') {
      notice.value = t('subdomainProcessing', {seconds: data.retryAfter})
      return
    }
    outcome.value = data
    sessionStorage.removeItem(storageKey.value)
    pending.value = null
    if (data.created) emit('created')
  } catch (error) {
    const code = error.response?.data?.code ?? error.code
    const message = error.response?.data?.message ?? error.message
    // These request-level rejections guarantee no work was accepted in this call.
    // Unknown/5xx/network errors retain the original request for safe retry.
    if (firstAttempt && [400, 401, 403, 404, 413].includes(code)) {
      sessionStorage.removeItem(storageKey.value)
      pending.value = null
      notice.value = errorText(message)
    } else {
      notice.value = t('subdomainUncertain')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.subdomain-form { display: flex; flex-direction: column; gap: 16px; max-height: 65vh; overflow-y: auto; padding-right: 4px; }
.owner, .preview { margin: 0; overflow-wrap: anywhere; }
.preview { color: var(--el-color-primary); }
.created { color: var(--el-color-success); }
.failed { color: var(--el-color-danger); }
</style>
