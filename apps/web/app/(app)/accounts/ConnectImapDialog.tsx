"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import { MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/Input";
import { toastSuccess, toastError } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { connectImapAccountAction } from "@/utils/actions/imap-connection";
import {
  connectImapAccountBody,
  type ConnectImapAccountBody,
} from "@/utils/actions/imap-connection.validation";
import { useAccounts } from "@/hooks/useAccounts";

export function ConnectImapDialog({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const { mutate } = useAccounts();

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<ConnectImapAccountBody>({
    resolver: zodResolver(connectImapAccountBody),
    defaultValues: { imapPort: 993, smtpPort: 587 },
  });

  const { execute, isExecuting } = useAction(connectImapAccountAction, {
    onSuccess: () => {
      toastSuccess({ description: "IMAP account connected!" });
      reset();
      setOpen(false);
      mutate();
    },
    onError: (error) => {
      toastError({ description: getActionErrorMessage(error.error) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full" disabled={disabled}>
          <MailIcon className="size-6" />
          <span className="ml-2">Add IMAP</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect an IMAP account</DialogTitle>
          <DialogDescription>
            Use an app password from your email provider. Connections require
            TLS: IMAP uses port 993 and SMTP uses port 465 or 587.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit(execute)}>
          <Input
            type="email"
            name="email"
            label="Email address"
            placeholder="you@example.com"
            registerProps={register("email")}
            error={errors.email}
          />
          <Input
            type="text"
            name="username"
            label="Username"
            explainText="Usually your full email address"
            registerProps={register("username")}
            error={errors.username}
          />
          <Input
            type="password"
            name="password"
            label="Password"
            registerProps={register("password")}
            error={errors.password}
          />
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Input
                type="text"
                name="imapHost"
                label="IMAP host"
                placeholder="imap.example.com"
                registerProps={register("imapHost")}
                error={errors.imapHost}
              />
            </div>
            <Input
              type="number"
              name="imapPort"
              label="IMAP port"
              registerProps={register("imapPort")}
              error={errors.imapPort}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Input
                type="text"
                name="smtpHost"
                label="SMTP host"
                placeholder="smtp.example.com"
                registerProps={register("smtpHost")}
                error={errors.smtpHost}
              />
            </div>
            <Input
              type="number"
              name="smtpPort"
              label="SMTP port"
              registerProps={register("smtpPort")}
              error={errors.smtpPort}
            />
          </div>
          <Input
            type="password"
            name="smtpPassword"
            label="SMTP password (optional)"
            explainText="Leave empty to use the same password as IMAP"
            registerProps={register("smtpPassword")}
            error={errors.smtpPassword}
          />
          <Button type="submit" loading={isExecuting} className="w-full">
            Test connection and add account
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
