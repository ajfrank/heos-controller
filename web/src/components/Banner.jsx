import React from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';

// Persistent dismissable banner for failures the user must understand
// (e.g. HEOS rejecting a zone group). Toasts disappear; this stays.
export default function Banner({ banner, onDismiss }) {
  return (
    <AnimatePresence initial={false}>
      {banner && (
        <motion.div
          key={banner.id}
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          <Card radius="lg" classNames={{ base: 'bg-content2/70 border border-danger/60' }}>
            <CardBody className="flex flex-row items-start justify-between gap-3 p-3">
              <div className="flex-1 min-w-0 text-small">
                <p className="font-semibold text-danger">{banner.title || 'Something went wrong'}</p>
                <p className="text-default-500 mt-0.5">{banner.text}</p>
              </div>
              <Button
                size="sm"
                variant="flat"
                radius="lg"
                onPress={onDismiss}
                aria-label="Dismiss"
              >
                Dismiss
              </Button>
            </CardBody>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
