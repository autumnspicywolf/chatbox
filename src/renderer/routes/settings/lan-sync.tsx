import { Box, Title } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import LanSyncSetting from '@/components/settings/lan-sync/LanSyncSetting'

export const Route = createFileRoute('/settings/lan-sync')({
  component: RouteComponent,
})

export function RouteComponent() {
  const { t } = useTranslation()
  return (
    <Box p="md">
      <Title order={5}>{t('LAN Sync')}</Title>
      <Box className="mt-4">
        <LanSyncSetting />
      </Box>
    </Box>
  )
}
